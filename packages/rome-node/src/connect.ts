import { hostname } from "node:os";
import { join } from "node:path";
import { rm } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { isRecord } from "./actions.js";
import { cloudOrigin, cloudRequest, CloudError, gatewayConfig } from "./cloud.js";
import { connectGateway } from "./client.js";
import { createNodeSocket } from "./socket.js";
import { loginDevice, type DeviceSession } from "./login.js";
import { readPrivateJson, writePrivateJson } from "./storage.js";
import { createExecutor } from "./executor.js";
import { validId } from "./protocol.js";
import { configRoot } from "./local.js";

export async function connectComputer(
  origin: string,
  name: string,
  signal: AbortSignal,
): Promise<void> {
  const cloudUrl = cloudOrigin(origin);
  const path = join(configRoot(), "credential.json");
  const stored = await readPrivateJson(path);
  let session: (DeviceSession & { name: string }) | null =
    isRecord(stored) &&
    stored.cloudUrl === cloudUrl &&
    typeof stored.token === "string" &&
    /^romedev_[A-Za-z0-9_-]{43}$/.test(stored.token) &&
    validId(stored.deviceId) &&
    typeof stored.name === "string"
      ? { cloudUrl, token: stored.token, deviceId: stored.deviceId, name: stored.name }
      : null;
  let gatewayUrl = "";
  let attempt = 0;
  while (!signal.aborted) {
    if (!session) {
      process.stderr.write(
        "While connect is running, Rome instances in your account can execute programs and read or change files as your OS user.\n",
      );
      session = { ...(await loginDevice(cloudUrl, name, signal)), name };
      await writePrivateJson(path, session);
    }
    try {
      gatewayUrl = await gatewayConfig(cloudUrl, session.token);
      break;
    } catch (error) {
      if (error instanceof CloudError && error.code === "invalid_device_session") {
        await rm(path, { force: true });
        session = null;
        continue;
      }
      process.stderr.write("Rome Cloud is unavailable; keeping credentials and retrying.\n");
      await delay(Math.min(60_000, 1000 * 2 ** Math.min(attempt++, 6)), undefined, {
        signal,
      }).catch(() => {});
    }
  }
  if (signal.aborted || !session) return;
  const devices = await cloudRequest(cloudUrl, "/api/account/devices", session.token).catch(
    () => null,
  );
  if (isRecord(devices) && Array.isArray(devices.items)) {
    const device = devices.items.find(
      (item: unknown) => isRecord(item) && item.id === session?.deviceId,
    );
    if (isRecord(device) && typeof device.device_name === "string") {
      session.name = device.device_name;
      await writePrivateJson(path, session);
    }
  }
  if (signal.aborted) return;
  const active = session;
  process.stderr.write(`Device: ${active.name}\nDevice ID: ${active.deviceId}\n`);
  await new Promise<void>((resolve, reject) => {
    const executor = createExecutor(active.name, (message) => connection.send(message), [
      active.token,
    ]);
    const finish = (error?: Error) => {
      signal.removeEventListener("abort", abort);
      executor.disconnect();
      connection.stop();
      if (error) reject(error);
      else resolve();
    };
    const abort = () => finish();
    const connection = connectGateway({
      gatewayUrl,
      deviceToken: active.token,
      createSocket: createNodeSocket,
      beforeConnect: async () => {
        try {
          return await gatewayConfig(cloudUrl, active.token);
        } catch (error) {
          if (error instanceof CloudError && error.code === "invalid_device_session") return null;
          throw error;
        }
      },
      onMessage: (message) => {
        if ("from" in message) void executor.receive(message);
      },
      onStatus: (status) => {
        process.stderr.write(`Connection: ${status}\n`);
        if (status !== "online" && status !== "connecting") executor.disconnect();
        if (status === "revoked" || status === "superseded") {
          queueMicrotask(() =>
            finish(
              new Error(
                status === "revoked"
                  ? "Authorization revoked. Run rome-node connect again to authorize."
                  : "Another connection replaced this device. This process has stopped.",
              ),
            ),
          );
        }
      },
    });
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
  });
}

export const defaultDeviceName = () =>
  hostname()
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .slice(0, 80) || "Computer";
