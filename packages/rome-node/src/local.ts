import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { isRecord } from "./actions.js";
import { cloudOrigin } from "./cloud.js";
import { readPrivateJson } from "./storage.js";

export function configRoot(): string {
  return resolve(
    process.env.ROME_NODE_CONFIG_DIR ||
      (process.platform === "win32"
        ? join(process.env.LOCALAPPDATA || homedir(), "RomeNode")
        : join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "rome-node")),
  );
}

export const callerCredentialPath = () => join(configRoot(), "caller.json");
export const daemonStatePath = () => join(configRoot(), "daemon.json");

export function daemonPort(): number {
  const override = process.env.ROME_NODE_DAEMON_PORT;
  if (override !== undefined) {
    const port = Number(override);
    if (!Number.isInteger(port) || port < 1024 || port > 65535)
      throw new Error("ROME_NODE_DAEMON_PORT must be a port between 1024 and 65535.");
    return port;
  }
  return 20000 + (createHash("sha256").update(configRoot()).digest().readUInt32BE(0) % 40000);
}

export interface CallerCredential {
  cloudUrl: string;
  token: string;
}

export async function readCallerCredential(): Promise<CallerCredential> {
  const value = await readPrivateJson(callerCredentialPath());
  if (
    !isRecord(value) ||
    typeof value.cloudUrl !== "string" ||
    typeof value.token !== "string" ||
    !/^romedev_[A-Za-z0-9_-]{43}$/.test(value.token)
  )
    throw new Error(
      "Configure a communication token with rome-node auth --cloud <origin> using stdin first.",
    );
  return { cloudUrl: cloudOrigin(value.cloudUrl), token: value.token };
}
