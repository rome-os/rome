import { hostname } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { isRecord } from "./actions.js";
import { cloudOrigin, cloudRequest, CloudError, gatewayConfig } from "./cloud.js";
import { connectGateway } from "./client.js";
import { createNodeSocket } from "./socket.js";
import type { DeviceSession } from "./login.js";
import type { CredentialStore } from "./storage.js";
import { createExecutor } from "./executor.js";
import { validId } from "./protocol.js";

export type HostCredential = DeviceSession & { name: string };
export type HostEvent =
  | { type: "authorization_required" }
  | { type: "retrying" }
  | { type: "device"; name: string; deviceId: string }
  | { type: "connection"; status: import("./client.js").ConnectionStatus };

export interface HostOptions {
  cloudUrl: string;
  name: string;
  signal: AbortSignal;
  credentials: CredentialStore<HostCredential>;
  authorize(cloudUrl: string, name: string, signal: AbortSignal): Promise<DeviceSession>;
  onEvent?(event: HostEvent): void;
}

/** Runs until aborted or authorization ends. The caller owns interaction and credential storage. */
export async function connectHost(options: HostOptions): Promise<void> {
  const { name, signal, credentials } = options;
  if (signal.aborted) return;
  const cloudUrl = cloudOrigin(options.cloudUrl);
  const stored = await credentials.load();
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
      options.onEvent?.({ type: "authorization_required" });
      session = { ...(await options.authorize(cloudUrl, name, signal)), name };
      await credentials.save(session);
    }
    try {
      gatewayUrl = await gatewayConfig(cloudUrl, session.token);
      break;
    } catch (error) {
      if (error instanceof CloudError && error.code === "invalid_device_session") {
        await credentials.clear();
        session = null;
        continue;
      }
      options.onEvent?.({ type: "retrying" });
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
      await credentials.save(session);
    }
  }
  if (signal.aborted) return;
  const active = session;
  options.onEvent?.({ type: "device", name: active.name, deviceId: active.deviceId });
  await new Promise<void>((resolve, reject) => {
    const executor = createExecutor(active.name, (message) => connection.send(message), [
      active.token,
    ]);
    let finished = false;
    const finish = (error?: Error) => {
      if (finished) return;
      finished = true;
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
        options.onEvent?.({ type: "connection", status });
        if (status !== "online" && status !== "connecting") executor.disconnect();
        if (status === "revoked" || status === "superseded") {
          queueMicrotask(() =>
            finish(
              new Error(
                status === "revoked"
                  ? "Authorization revoked. Explicit authorization is required."
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
