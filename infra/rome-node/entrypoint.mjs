import { setTimeout as delay } from "node:timers/promises";
import { AuditStore, connectHost, defaultDeviceName } from "./dist/host.js";
import { cloudOrigin, validId } from "./dist/index.js";

const stop = new AbortController();
process.once("SIGTERM", () => stop.abort());
process.once("SIGINT", () => stop.abort());

try {
  const {
    ROME_NODE_CLOUD_URL: url,
    ROME_NODE_DEVICE_ID: deviceId,
    ROME_NODE_TOKEN: token,
  } = process.env;
  delete process.env.ROME_NODE_TOKEN;
  if (!url || !validId(deviceId) || !/^romedev_[A-Za-z0-9_-]{43}$/.test(token ?? ""))
    throw new Error("Invalid Compose configuration.");

  const cloudUrl = cloudOrigin(url);
  const name = defaultDeviceName();
  let credential = { cloudUrl, deviceId, token, name };
  let accessEnded = false;
  const audit = await AuditStore.open({
    path: "/var/lib/rome-node/audit.db",
    entry: "cli",
    hint: "Check that the Rome Node audit volume is writable.",
  });
  if (audit.state.state === "unavailable") console.error(audit.state.message, audit.hint);
  try {
    await connectHost({
      cloudUrl,
      name,
      signal: stop.signal,
      audit,
      credentials: {
        load: async () => credential,
        save: async (value) => {
          credential = value;
        },
        clear: async () => {
          credential = null;
        },
      },
      authorize: async () => {
        accessEnded = true;
        throw new Error("Authorization expired or was revoked. Generate a new Compose file.");
      },
      onEvent(event) {
        if (event.type !== "connection") return;
        console.info(`Connection: ${event.status}`);
        if (event.status === "revoked" || event.status === "superseded") accessEnded = true;
      },
    });
  } catch (error) {
    if (!accessEnded) throw error;
    console.error(error.message);
    // Stay idle after access ends so Docker does not reconnect with the same credential.
    while (!stop.signal.aborted)
      await delay(2_147_483_647, undefined, { signal: stop.signal }).catch(() => {});
  } finally {
    audit.close();
  }
} catch (error) {
  const detail = error instanceof Error ? error.message : "Unexpected error.";
  console.error(
    "Could not start Rome Node.",
    detail.replace(/rome(?:dev|mob)_[A-Za-z0-9_-]{43}/g, "[redacted]"),
  );
  process.exitCode = 1;
}
