import { randomBytes, timingSafeEqual } from "node:crypto";
import { spawn } from "node:child_process";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import { actionError, isRecord } from "./actions.js";
import { DeviceConnector } from "./connector.js";
import { configRoot, daemonPort, daemonStatePath, readCallerCredential } from "./local.js";
import { MAX_MESSAGE_BYTES } from "./protocol.js";
import { readPrivateJson, writePrivateJson } from "./storage.js";

interface DaemonState {
  token: string;
  port: number;
  pid: number;
}

async function readDaemonState(): Promise<DaemonState | null> {
  const value = await readPrivateJson(daemonStatePath());
  if (
    !isRecord(value) ||
    typeof value.token !== "string" ||
    !/^romenode_[A-Za-z0-9_-]{43}$/.test(value.token) ||
    value.port !== daemonPort() ||
    typeof value.pid !== "number" ||
    !Number.isSafeInteger(value.pid) ||
    value.pid <= 0
  )
    return null;
  return { token: value.token, port: daemonPort(), pid: value.pid };
}

async function request(state: DaemonState, path: string, body?: unknown): Promise<Response> {
  return fetch(`http://127.0.0.1:${state.port}${path}`, {
    method: body === undefined ? "GET" : "POST",
    redirect: "error",
    signal: AbortSignal.timeout(path === "/status" ? 1000 : 85_000),
    headers: { authorization: `Bearer ${state.token}`, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

export async function daemonStatus(): Promise<DaemonState | null> {
  const state = await readDaemonState();
  if (!state) return null;
  try {
    const response = await request(state, "/status");
    const value: unknown = await response.json();
    return response.ok && isRecord(value) && value.pid === state.pid ? state : null;
  } catch {
    return null;
  }
}

export async function startDaemon(): Promise<DaemonState> {
  const current = await daemonStatus();
  if (current) return current;
  await readCallerCredential();
  const child = spawn(process.execPath, [process.argv[1], "daemon", "serve"], {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
    env: { ...process.env, ROME_NODE_CONFIG_DIR: configRoot() },
  });
  let failed = false;
  child.on("error", () => {
    failed = true;
  });
  child.unref();
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline && !failed) {
    const state = await daemonStatus();
    if (state) return state;
    await delay(50);
  }
  throw new Error(
    "Could not start the CLI daemon. Run rome-node daemon serve to inspect the error. If its port is occupied, set ROME_NODE_DAEMON_PORT.",
  );
}

export async function stopDaemon(): Promise<void> {
  const state = await daemonStatus();
  if (!state) return;
  const response = await request(state, "/stop", {});
  if (!response.ok) throw new Error("Could not stop the CLI daemon.");
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    try {
      const status = await request(state, "/status");
      if (status.status === 401) return;
    } catch {
      return;
    }
    await delay(50);
  }
  throw new Error("The CLI daemon has not stopped yet.");
}

export async function callDaemon(path: "/devices" | "/run", body?: unknown): Promise<Response> {
  const state = await startDaemon();
  try {
    return await request(state, path, body);
  } catch {
    // A failed local request can follow successful remote execution. Never resend it.
    throw new Error(
      "CLI daemon connection failed. Execution outcome may be unknown; do not automatically retry.",
    );
  }
}

function json(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  response.end(JSON.stringify(value));
}

async function readBody(request: IncomingMessage): Promise<unknown> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    const buffer = Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_MESSAGE_BYTES) throw new Error("message_too_large");
    chunks.push(buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

export async function serveDaemon(): Promise<void> {
  const credential = await readCallerCredential();
  const connector = new DeviceConnector({ credential });
  const state = {
    port: daemonPort(),
    pid: process.pid,
    token: `romenode_${randomBytes(32).toString("base64url")}`,
  };
  let closing = false;
  const server = createServer((req, res) => {
    void handle(req, res).catch(() => {
      if (!res.headersSent)
        json(res, 503, actionError("gateway_unavailable", "The device service is unavailable."));
      else res.destroy();
    });
  });
  server.requestTimeout = 10_000;
  server.headersTimeout = 10_000;
  const close = () => {
    if (closing) return;
    closing = true;
    connector.stop();
    server.close();
    server.closeIdleConnections();
    const timer = setTimeout(() => server.closeAllConnections(), 1000);
    timer.unref();
  };
  async function handle(req: IncomingMessage, res: ServerResponse) {
    const actual = Buffer.from(req.headers.authorization ?? "");
    const expected = Buffer.from(`Bearer ${state.token}`);
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
      json(res, 401, actionError("unauthorized", "A CLI daemon credential is required."));
      return;
    }
    if (closing) {
      json(res, 503, actionError("daemon_stopped", "The CLI daemon is stopping."));
    } else if (req.method === "GET" && req.url === "/status") {
      json(res, 200, { pid: state.pid });
    } else if (req.method === "POST" && req.url === "/stop") {
      json(res, 200, { stopped: true });
      close();
    } else if (req.method === "GET" && req.url === "/devices") {
      json(res, 200, await connector.list());
    } else if (req.method === "POST" && req.url === "/run") {
      if (Number(req.headers["content-length"]) > MAX_MESSAGE_BYTES) {
        json(res, 413, actionError("message_too_large", "The request exceeds 128 KiB."));
        req.resume();
        return;
      }
      let body: unknown;
      try {
        body = await readBody(req);
      } catch (error) {
        const tooLarge = error instanceof Error && error.message === "message_too_large";
        json(
          res,
          tooLarge ? 413 : 400,
          actionError(
            tooLarge ? "message_too_large" : "invalid_request",
            "Invalid device request.",
          ),
        );
        return;
      }
      if (!isRecord(body) || typeof body.deviceId !== "string" || typeof body.action !== "string") {
        json(res, 400, actionError("invalid_request", "A device ID and action are required."));
        return;
      }
      json(res, 200, await connector.run(body.deviceId, body.action, body.args ?? {}));
    } else {
      json(res, 404, actionError("not_found", "Unknown CLI daemon operation."));
    }
  }
  // The OS bind chooses one owner before any process writes shared state or opens Gateway.
  // A losing concurrent launcher must not replace the winning process's credentials.
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(state.port, "127.0.0.1", () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
  const finished = new Promise<void>((resolve) => server.once("close", resolve));
  process.once("SIGINT", close);
  process.once("SIGTERM", close);
  try {
    await writePrivateJson(daemonStatePath(), state);
    await finished;
  } finally {
    close();
    process.removeListener("SIGINT", close);
    process.removeListener("SIGTERM", close);
    // Stale discovery is harmless; the next owner replaces it after binding.
    // Removing it after close could erase a successor's state.
  }
}
