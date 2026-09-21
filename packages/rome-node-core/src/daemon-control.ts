import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { isRecord } from "./actions.js";
import { DAEMON_PROTOCOL_VERSION, type DaemonStatus } from "./daemon-protocol.js";
import { connectRpc, DaemonVersionError, type DaemonState } from "./daemon-rpc.js";
import { daemonStatePath, readCallerCredential, type NodeConfig } from "./local.js";
import { readPrivateJson } from "./storage.js";

async function readDaemonState(config: NodeConfig): Promise<DaemonState | null> {
  const value = await readPrivateJson(daemonStatePath(config));
  if (
    !isRecord(value) ||
    typeof value.token !== "string" ||
    !/^romenode_[A-Za-z0-9_-]{43}$/.test(value.token) ||
    value.port !== config.port ||
    typeof value.pid !== "number" ||
    !Number.isSafeInteger(value.pid) ||
    value.pid <= 0
  )
    return null;
  return {
    token: value.token,
    port: config.port,
    pid: value.pid,
    ...(typeof value.protocolVersion === "number"
      ? { protocolVersion: value.protocolVersion }
      : {}),
  };
}

// Only discovery and explicit shutdown recognize the HTTP daemon during upgrades.
async function legacyRequest(state: DaemonState, path: "/status" | "/stop") {
  const response = await fetch(`http://127.0.0.1:${state.port}${path}`, {
    method: path === "/stop" ? "POST" : "GET",
    headers: { authorization: `Bearer ${state.token}` },
    redirect: "error",
    signal: AbortSignal.timeout(1000),
  });
  const value: unknown = await response.json();
  return response.ok && isRecord(value) ? value : null;
}

export async function findDaemon(config: NodeConfig, signal?: AbortSignal) {
  signal?.throwIfAborted();
  const state = await readDaemonState(config);
  if (!state) return null;
  if (state.protocolVersion !== DAEMON_PROTOCOL_VERSION) {
    const legacy = await legacyRequest(state, "/status").catch(() => null);
    if (legacy?.pid === state.pid) throw new DaemonVersionError();
  }
  try {
    return await connectRpc(state, signal);
  } catch (error) {
    signal?.throwIfAborted();
    if (error instanceof DaemonVersionError) throw error;
    return null;
  }
}

/** Reads status without starting the daemon or opening a Gateway connection. */
export async function daemonStatus(config: NodeConfig): Promise<DaemonStatus | null> {
  const found = await findDaemon(config);
  if (!found) return null;
  found.rpc.close();
  return found.status;
}

export async function ensureDaemon(config: NodeConfig, signal?: AbortSignal) {
  const current = await findDaemon(config, signal);
  if (current) return current;
  await readCallerCredential(config);
  signal?.throwIfAborted();
  let child: ChildProcess | undefined;
  let failed = false;
  let nextLaunch = 0;
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline && !failed) {
    const current = await findDaemon(config, signal);
    if (current) return current;
    signal?.throwIfAborted();
    // A stopping daemon can reject discovery before its listener is released.
    // Retry only exited launchers, and only before any device request is submitted.
    if (!child && Date.now() >= nextLaunch && Date.now() < deadline) {
      const launched = spawn(
        process.execPath,
        [fileURLToPath(new URL("../bin/daemon.js", import.meta.url))],
        {
          detached: true,
          stdio: "ignore",
          windowsHide: true,
          env: {
            ...process.env,
            ROME_NODE_CONFIG_DIR: config.directory,
            ROME_NODE_DAEMON_PORT: String(config.port),
          },
        },
      );
      child = launched;
      nextLaunch = Date.now() + 250;
      launched.once("error", () => {
        failed = true;
      });
      launched.once("exit", () => {
        if (child === launched) child = undefined;
      });
      launched.unref();
    }
    await delay(50, undefined, { signal });
  }
  throw new Error(
    "Could not start the caller daemon. Check the configuration directory and daemon port.",
  );
}

export async function startDaemon(config: NodeConfig): Promise<DaemonStatus> {
  const { rpc, status } = await ensureDaemon(config);
  rpc.close();
  return status;
}

/** Stops the shared service only on explicit request, including the HTTP daemon during an upgrade. */
export async function stopDaemon(config: NodeConfig): Promise<void> {
  const state = await readDaemonState(config);
  if (!state) return;
  if (state.protocolVersion !== DAEMON_PROTOCOL_VERSION) {
    const legacy = await legacyRequest(state, "/status").catch(() => null);
    if (legacy?.pid === state.pid) {
      await legacyRequest(state, "/stop");
    } else return;
  } else {
    const found = await findDaemon(config);
    if (!found) return;
    try {
      await found.rpc.request("daemon.stop", {}, 5000);
    } finally {
      found.rpc.close();
    }
  }
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const found = await findDaemon(config).catch((error) => {
      if (error instanceof DaemonVersionError) return "legacy" as const;
      throw error;
    });
    if (!found) return;
    if (found !== "legacy") {
      found.rpc.close();
      if (found.status.pid !== state.pid) return;
    }
    await delay(50);
  }
  throw new Error("The caller daemon has not stopped yet.");
}
