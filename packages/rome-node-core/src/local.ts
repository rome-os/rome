import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { isRecord } from "./actions.js";
import { cloudOrigin } from "./cloud.js";
import { readPrivateJson } from "./storage.js";

export interface NodeConfig {
  directory: string;
  port: number;
}

export function createNodeConfig(options: { directory: string; port?: number }): NodeConfig {
  const directory = resolve(options.directory);
  const port =
    options.port ??
    20000 + (createHash("sha256").update(directory).digest().readUInt32BE(0) % 40000);
  if (!Number.isInteger(port) || port < 1024 || port > 65535)
    throw new Error("The daemon port must be between 1024 and 65535.");
  return { directory, port };
}

/** Pass the same environment or explicit directory to clients that share a daemon. */
export function nodeConfigFromEnvironment(env: Record<string, string | undefined>): NodeConfig {
  return createNodeConfig({
    directory:
      env.ROME_NODE_CONFIG_DIR ||
      (process.platform === "win32"
        ? join(env.LOCALAPPDATA || homedir(), "RomeNode")
        : join(env.XDG_CONFIG_HOME || join(homedir(), ".config"), "rome-node")),
    port: env.ROME_NODE_DAEMON_PORT === undefined ? undefined : Number(env.ROME_NODE_DAEMON_PORT),
  });
}

export const callerCredentialPath = (config: NodeConfig) => join(config.directory, "caller.json");
export const daemonStatePath = (config: NodeConfig) => join(config.directory, "daemon.json");

export interface CallerCredential {
  cloudUrl: string;
  token: string;
}

export class CallerConfigurationError extends Error {
  constructor(
    readonly code: "not_configured" | "daemon_running" | "instance_token_required",
    message: string,
  ) {
    super(message);
  }
}

export async function readOptionalCallerCredential(
  config: NodeConfig,
): Promise<CallerCredential | null> {
  const value = await readPrivateJson(callerCredentialPath(config));
  if (
    !isRecord(value) ||
    typeof value.cloudUrl !== "string" ||
    typeof value.token !== "string" ||
    !/^romedev_[A-Za-z0-9_-]{43}$/.test(value.token)
  )
    return null;
  return { cloudUrl: cloudOrigin(value.cloudUrl), token: value.token };
}

export async function readCallerCredential(config: NodeConfig): Promise<CallerCredential> {
  const credential = await readOptionalCallerCredential(config);
  if (!credential)
    throw new CallerConfigurationError(
      "not_configured",
      "A caller communication credential is required.",
    );
  return credential;
}
