import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage } from "node:http";
import { createRequire } from "node:module";
import { join } from "node:path";
import WebSocket, { WebSocketServer } from "ws";
import { actionError, isRecord, type ActionResponse } from "./actions.js";
import type { ConnectionStatus } from "./client.js";
import { ObserveStore, QueryError, type ActionEnd, type ActionStart } from "./observe.js";
import type { LogQuery, LogStatsQuery, NodeEvent, NodeStatus } from "./observe-protocol.js";
import { DeviceConnector } from "./connector.js";
import { daemonStatePath, readCallerCredential, type NodeConfig } from "./local.js";
import { writePrivateJson } from "./storage.js";
import {
  DAEMON_PROTOCOL_VERSION,
  encodeBinaryMessage,
  MAX_LOCAL_MESSAGE_BYTES,
  parseBinaryMessage,
  type DaemonStatus,
} from "./daemon-protocol.js";
import { DeviceStatusReader } from "./devices-status.js";
import { RpcError } from "./daemon-rpc.js";
import { isAbsolute } from "node:path";
import { isUuid } from "./frame.js";
import { copyWithDevice, TRANSFER_VERSION, TransferError } from "./transfer.js";
import type { CopyRequest } from "./daemon-protocol.js";

const PRUNE_INTERVAL_MS = 60 * 60 * 1000;
const { version: NODE_CORE_VERSION } = createRequire(import.meta.url)("../package.json") as {
  version: string;
};

interface Peer {
  socket: WebSocket;
  ready: boolean;
  subscribed: boolean;
  /** Subscribed to the `node` topic. */
  observing: boolean;
  alive: boolean;
  pending: Set<string | number>;
  /** Event notification bytes handed to the socket and not yet flushed. */
  eventBytes: number;
  /** Aborts this client's running copies when its socket closes. */
  copies: Set<AbortController>;
}

function copyRequest(params: Record<string, unknown>): CopyRequest | null {
  const { direction, localPath, deviceId, remotePath } = params;
  if (
    (direction !== "push" && direction !== "pull") ||
    typeof localPath !== "string" ||
    !isAbsolute(localPath) ||
    localPath.includes("\0") ||
    !isUuid(deviceId) ||
    typeof remotePath !== "string" ||
    !remotePath ||
    remotePath.includes("\0")
  )
    return null;
  return { direction, localPath, deviceId: deviceId.toLowerCase(), remotePath };
}
function byteCount(value: unknown): number {
  return typeof value === "string" ? Buffer.byteLength(value) : 0;
}

/** What the observation log stores about a device action when it starts. */
function actionStart(
  deviceId: string,
  action: string,
  args: unknown,
  mode: "json" | "binary",
  stdinBytes = 0,
): ActionStart {
  const exec = action === "exec" && isRecord(args) && typeof args.command === "string";
  let text: string | null = null;
  if (!exec)
    try {
      text = JSON.stringify(args ?? {});
    } catch {}
  return {
    direction: "out",
    peer: deviceId.toLowerCase(),
    action,
    mode,
    command: exec ? (args.command as string) : null,
    args: exec ? (Array.isArray(args.args) ? args.args.map(String) : []) : text,
    cwd: exec && typeof args.cwd === "string" ? args.cwd : null,
    stdinBytes,
  };
}

/** Maps an action response to its stored outcome. Program output is counted, never stored. */
function actionEnd(response: ActionResponse, stdoutBytes?: number): ActionEnd {
  if (!response.ok) {
    const code = response.error.code;
    return {
      outcome:
        code === "unknown_outcome" ? "unknown_outcome" : code === "canceled" ? "aborted" : "error",
      errorCode: code,
    };
  }
  const result = isRecord(response.result) ? response.result : {};
  return {
    outcome: "ok",
    exitCode: Number.isSafeInteger(result.exitCode) ? (result.exitCode as number) : null,
    signal: typeof result.signal === "string" ? result.signal : null,
    stdoutBytes: stdoutBytes ?? byteCount(result.stdout),
    stderrBytes: byteCount(result.stderr),
  };
}

function logQuery(params: Record<string, unknown>): LogQuery {
  if (params.kind !== "actions") throw new RpcError(-32602, "log.query requires kind actions.");
  return params as unknown as LogQuery;
}

/** A JSON-RPC response. A body makes it one binary message. */
interface Reply {
  message: unknown;
  body?: Uint8Array;
}

export async function serveDaemon(config: NodeConfig, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return;
  const credential = await readCallerCredential(config);
  const peers = new Set<Peer>();
  const state = {
    port: config.port,
    pid: process.pid,
    protocolVersion: DAEMON_PROTOCOL_VERSION,
    token: `romenode_${randomBytes(32).toString("base64url")}`,
  };
  const startedAt = Date.now();
  let closing = false;
  // The store opens only after the listener binds, so a losing daemon never touches the file.
  const store = new ObserveStore({
    path: join(config.directory, "observe.db"),
    secrets: [credential.token, state.token],
  });
  const caller = {
    connection: "stopped" as ConnectionStatus,
    since: startedAt,
    onlineOnce: false,
    reconnects: 0,
    running: 0,
  };
  const connector = new DeviceConnector({
    credential,
    onStatus: (status) => {
      deviceStatus.invalidate();
      for (const peer of peers) if (peer.subscribed) notify(peer);
      if (status === caller.connection) return;
      const at = Date.now();
      caller.connection = status;
      caller.since = at;
      if (status === "online") {
        if (caller.onlineOnce) caller.reconnects++;
        caller.onlineOnce = true;
      }
      broadcast({ type: "connection", role: "caller", status, at });
    },
  });
  const deviceStatus = new DeviceStatusReader(connector);
  const snapshot = (): DaemonStatus => ({
    pid: state.pid,
    protocolVersion: DAEMON_PROTOCOL_VERSION,
    connection: connector.getStatus(),
  });
  const nodeStatus = (): NodeStatus => ({
    version: NODE_CORE_VERSION,
    startedAt,
    roles: {
      caller: {
        auth: caller.connection === "revoked" ? "revoked" : "authorized",
        connection: caller.connection,
        since: caller.since,
        reconnects: caller.reconnects,
        running: caller.running,
      },
    },
  });
  /** Records a device action around `work`, unless the action is a probe. */
  async function observed<T>(
    start: ActionStart | null,
    work: () => Promise<T>,
    end: (value: T) => ActionEnd,
  ): Promise<T> {
    if (!start) return work();
    caller.running++;
    const row = store.startAction(start);
    if (row) broadcast({ type: "action", id: row.id, phase: "start", row });
    let ended: ActionEnd = { outcome: "error", errorCode: "daemon_error" };
    try {
      const value = await work();
      ended = end(value);
      return value;
    } finally {
      caller.running--;
      const done = row && store.endAction(row.id, ended);
      if (done) broadcast({ type: "action", id: done.id, phase: "end", row: done });
    }
  }
  function authorized(req: IncomingMessage) {
    const actual = Buffer.from(req.headers.authorization ?? "");
    const expected = Buffer.from(`Bearer ${state.token}`);
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  }
  const server = createServer((req, res) => {
    res.writeHead(authorized(req) ? 426 : 401, { "cache-control": "no-store" }).end();
  });
  server.headersTimeout = 10_000;
  const sockets = new WebSocketServer({
    noServer: true,
    perMessageDeflate: false,
    maxPayload: MAX_LOCAL_MESSAGE_BYTES,
  });
  server.on("upgrade", (req, socket, head) => {
    if (closing || req.url !== "/rpc" || req.headers.origin || !authorized(req)) {
      socket.end("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
      return;
    }
    sockets.handleUpgrade(req, socket, head, (socket) => sockets.emit("connection", socket));
  });
  function send(peer: Peer, value: unknown) {
    if (peer.socket.readyState !== WebSocket.OPEN) return;
    peer.socket.send(JSON.stringify(value), (error) => {
      if (error) peer.socket.terminate();
    });
  }
  function deliver(peer: Peer, reply: Reply) {
    if (!reply.body) {
      send(peer, reply.message);
      return;
    }
    if (peer.socket.readyState !== WebSocket.OPEN) return;
    let data = encodeBinaryMessage(reply.message, reply.body);
    if (data.byteLength > MAX_LOCAL_MESSAGE_BYTES) {
      const id = isRecord(reply.message) ? reply.message.id : null;
      data = encodeBinaryMessage(
        {
          jsonrpc: "2.0",
          id,
          result: actionError(
            "message_too_large",
            "The response exceeds the local message limit. The action may have completed.",
          ),
        },
        new Uint8Array(),
      );
    }
    peer.socket.send(data, { binary: true }, (error) => {
      if (error) peer.socket.terminate();
    });
  }
  function notify(peer: Peer) {
    emit(peer, "events.connection", snapshot());
  }
  function broadcast(event: NodeEvent) {
    for (const peer of peers) if (peer.observing) emit(peer, "events.node", event);
  }
  function emit(peer: Peer, method: string, params: unknown) {
    // A slow observer must not accumulate unbounded event data or block other clients.
    // Only event bytes count, so a large binary response in flight does not trip the limit.
    if (peer.eventBytes > 1024 * 1024) {
      peer.socket.terminate();
      return;
    }
    if (peer.socket.readyState !== WebSocket.OPEN) return;
    const text = JSON.stringify({ jsonrpc: "2.0", method, params });
    const size = Buffer.byteLength(text);
    peer.eventBytes += size;
    peer.socket.send(text, (error) => {
      peer.eventBytes -= size;
      if (error) peer.socket.terminate();
    });
  }
  const close = () => {
    if (closing) return;
    closing = true;
    connector.stop();
    for (const peer of peers) peer.socket.close(1001, "daemon stopped");
    server.close();
    sockets.close();
    const timer = setTimeout(() => {
      for (const peer of peers) peer.socket.terminate();
      server.closeAllConnections();
    }, 1000);
    timer.unref();
  };
  async function copyFile(
    peer: Peer,
    id: string | number | null,
    request: CopyRequest,
  ): Promise<ActionResponse> {
    // The controller exists before the first await. A client that disconnects during the
    // capability probe below then cancels the copy instead of leaving it to run unowned.
    const controller = new AbortController();
    peer.copies.add(controller);
    if (peer.socket.readyState !== WebSocket.OPEN) controller.abort();
    const canceled = () =>
      actionError("canceled", "The client disconnected. The copy did not start.");
    let last = 0;
    try {
      if (controller.signal.aborted) return canceled();
      const info = await connector.run(request.deviceId, "system.info", {});
      if (controller.signal.aborted) return canceled();
      if (!info.ok) return info;
      if (!isRecord(info.result) || info.result.transferVersion !== TRANSFER_VERSION)
        return actionError(
          "unsupported_device",
          "The device runs a rome-node version without file transfers. Update rome-node on that device.",
        );
      const summary = await copyWithDevice(
        (events) => connector.openChannel(request.deviceId, events),
        request,
        {
          signal: controller.signal,
          onProgress: ({ bytes, total }) => {
            const now = Date.now();
            if (now - last < 250 && bytes !== total) return;
            last = now;
            send(peer, {
              jsonrpc: "2.0",
              method: "events.transfer",
              params: { requestId: id, bytes, total },
            });
          },
        },
      );
      return { type: "response", ok: true, result: summary };
    } catch (cause) {
      if (!(cause instanceof TransferError)) throw cause;
      return actionError(cause.code, cause.message);
    } finally {
      peer.copies.delete(controller);
    }
  }
  function error(id: unknown, code: number, message: string) {
    return { jsonrpc: "2.0", id, error: { code, message } };
  }
  async function dispatch(
    peer: Peer,
    value: unknown,
    input?: Uint8Array,
  ): Promise<Reply | undefined> {
    if (
      !isRecord(value) ||
      value.jsonrpc !== "2.0" ||
      typeof value.method !== "string" ||
      (Object.hasOwn(value, "id") &&
        typeof value.id !== "string" &&
        typeof value.id !== "number" &&
        value.id !== null)
    )
      return { message: error(null, -32600, "Invalid Request") };
    const hasId = Object.hasOwn(value, "id");
    const id = value.id as string | number | null;
    if (hasId && id !== null && peer.pending.has(id)) {
      peer.socket.close(1008, "duplicate request ID");
      return;
    }
    if (hasId && id !== null) peer.pending.add(id);
    try {
      if (closing) throw new RpcError(-32000, "The caller daemon is stopping.");
      const params = Object.hasOwn(value, "params") ? value.params : {};
      if (!isRecord(params)) throw new RpcError(-32602, "Invalid params");
      if ((value.method === "devices.runBinary") !== Boolean(input))
        throw new RpcError(
          -32600,
          "Only devices.runBinary uses binary messages, and it requires one.",
        );
      let result: unknown;
      let body: Uint8Array | undefined;
      if (value.method === "daemon.hello") {
        if (params.protocolVersion !== DAEMON_PROTOCOL_VERSION)
          throw new RpcError(-32002, "Incompatible daemon protocol.");
        peer.ready = true;
        result = snapshot();
      } else {
        if (!peer.ready) throw new RpcError(-32001, "Complete the daemon handshake first.");
        switch (value.method) {
          case "daemon.status":
            result = snapshot();
            break;
          case "daemon.stop":
            result = { stopped: true };
            setImmediate(close);
            break;
          case "node.status":
            result = nodeStatus();
            break;
          case "log.query":
            try {
              result = store.query(logQuery(params));
            } catch (cause) {
              if (cause instanceof QueryError) throw new RpcError(-32602, cause.message);
              throw cause;
            }
            break;
          case "log.stats":
            try {
              result = store.stats(params as unknown as LogStatsQuery);
            } catch (cause) {
              if (cause instanceof QueryError) throw new RpcError(-32602, cause.message);
              throw cause;
            }
            break;
          case "devices.status":
            result = await deviceStatus.read();
            break;
          case "devices.list":
            result = await connector.list();
            break;
          case "devices.run":
            if (typeof params.deviceId !== "string" || typeof params.action !== "string")
              throw new RpcError(-32602, "A device ID and action are required.");
            {
              const { deviceId, action } = params;
              const args = params.args ?? {};
              result = await observed(
                action === "system.info" ? null : actionStart(deviceId, action, args, "json"),
                () => connector.run(deviceId, action, args),
                (response) => actionEnd(response),
              );
            }
            break;
          case "devices.runBinary": {
            if (typeof params.deviceId !== "string" || typeof params.action !== "string")
              throw new RpcError(-32602, "A device ID and action are required.");
            const { deviceId, action } = params;
            const args = params.args ?? {};
            const stdin = input ?? new Uint8Array();
            const reply = await observed(
              actionStart(deviceId, action, args, "binary", stdin.byteLength),
              () => connector.runBinary(deviceId, action, args, stdin),
              ({ response, body }) => actionEnd(response, body.byteLength),
            );
            result = reply.response;
            body = reply.body;
            break;
          }
          case "files.copy": {
            const request = copyRequest(params);
            if (!request)
              throw new RpcError(
                -32602,
                "files.copy requires direction push or pull, an absolute localPath, a device UUID, and remotePath.",
              );
            result = await observed(
              {
                direction: "out",
                peer: request.deviceId,
                action: "copy",
                mode: "copy",
                transfer: {
                  direction: request.direction,
                  localPath: request.localPath,
                  remotePath: request.remotePath,
                },
              },
              () => copyFile(peer, id, request),
              (response): ActionEnd => {
                const summary = response.ok && isRecord(response.result) ? response.result : {};
                return {
                  ...actionEnd(response),
                  transferBytes: typeof summary.bytes === "number" ? summary.bytes : null,
                  sha256: typeof summary.sha256 === "string" ? summary.sha256 : null,
                };
              },
            );
            break;
          }
          case "events.subscribe":
          case "events.unsubscribe": {
            const on = value.method === "events.subscribe";
            // Register and send the first snapshot in one turn, before yielding or acknowledging.
            if (params.topic === "connection") {
              peer.subscribed = on;
              if (on) notify(peer);
            } else if (params.topic === "node") {
              peer.observing = on;
              if (on)
                emit(peer, "events.node", {
                  type: "snapshot",
                  status: nodeStatus(),
                  running: store.running(),
                } satisfies NodeEvent);
            } else throw new RpcError(-32602, "Unknown event topic.");
            result = { subscribed: on };
            break;
          }
          default:
            throw new RpcError(-32601, "Method not found");
        }
      }
      return hasId ? { message: { jsonrpc: "2.0", id, result }, body } : undefined;
    } catch (cause) {
      if (!hasId) return;
      return {
        message:
          cause instanceof RpcError
            ? error(id, cause.code, cause.message)
            : error(id, -32000, "The device service is unavailable."),
      };
    } finally {
      if (hasId && id !== null) peer.pending.delete(id);
    }
  }
  sockets.on("connection", (socket) => {
    const peer: Peer = {
      socket,
      ready: false,
      subscribed: false,
      observing: false,
      alive: true,
      pending: new Set(),
      eventBytes: 0,
      copies: new Set(),
    };
    peers.add(peer);
    socket.on("error", () => socket.terminate());
    socket.on("close", () => {
      peers.delete(peer);
      for (const copy of peer.copies) copy.abort();
    });
    socket.on("pong", () => {
      peer.alive = true;
    });
    socket.on("message", (data, binary) => {
      if (binary) {
        const parsed = parseBinaryMessage(
          Buffer.isBuffer(data)
            ? data
            : Array.isArray(data)
              ? Buffer.concat(data)
              : Buffer.from(data),
        );
        if (!parsed) {
          send(peer, error(null, -32600, "Invalid Request"));
          return;
        }
        void dispatch(peer, parsed.message, parsed.body)
          .then((reply) => reply && deliver(peer, reply))
          .catch(() => socket.terminate());
        return;
      }
      let request: unknown;
      try {
        request = JSON.parse(data.toString());
      } catch {
        send(peer, error(null, -32700, "Parse error"));
        return;
      }
      void (async () => {
        if (Array.isArray(request) && request.length > 0) {
          const responses = (await Promise.all(request.map((item) => dispatch(peer, item))))
            .filter((reply) => reply !== undefined)
            .map((reply) => reply.message);
          if (responses.length) send(peer, responses);
        } else {
          const reply = await dispatch(peer, request);
          if (reply !== undefined) send(peer, reply.message);
        }
      })().catch(() => socket.terminate());
    });
  });
  // Bind elects the owner before any process writes discovery state or connects to Gateway.
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(state.port, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  store.open();
  const pruner = setInterval(() => store.prune(), PRUNE_INTERVAL_MS);
  pruner.unref();
  const heartbeat = setInterval(() => {
    for (const peer of peers) {
      if (!peer.alive) {
        peer.socket.terminate();
        continue;
      }
      peer.alive = false;
      if (peer.socket.readyState === WebSocket.OPEN) peer.socket.ping();
    }
  }, 30_000);
  heartbeat.unref();
  const finished = new Promise<void>((resolve) => server.once("close", resolve));
  signal.addEventListener("abort", close, { once: true });
  try {
    await writePrivateJson(daemonStatePath(config), state);
    if (signal.aborted) close();
    await finished;
  } finally {
    close();
    clearInterval(heartbeat);
    clearInterval(pruner);
    store.close();
    signal.removeEventListener("abort", close);
    // A successor replaces discovery after binding. Removing it here could erase the new owner.
  }
}
