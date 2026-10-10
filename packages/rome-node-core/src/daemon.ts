import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage } from "node:http";
import WebSocket, { WebSocketServer } from "ws";
import { actionError, isRecord } from "./actions.js";
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

interface Peer {
  socket: WebSocket;
  ready: boolean;
  subscribed: boolean;
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
  let closing = false;
  const connector = new DeviceConnector({
    credential,
    onStatus: () => {
      deviceStatus.invalidate();
      for (const peer of peers) if (peer.subscribed) notify(peer);
    },
  });
  const deviceStatus = new DeviceStatusReader(connector);
  const snapshot = (): DaemonStatus => ({
    pid: state.pid,
    protocolVersion: DAEMON_PROTOCOL_VERSION,
    connection: connector.getStatus(),
  });
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
    // A slow observer must not accumulate unbounded event data or block other clients.
    // Only event bytes count, so a large binary response in flight does not trip the limit.
    if (peer.eventBytes > 1024 * 1024) {
      peer.socket.terminate();
      return;
    }
    if (peer.socket.readyState !== WebSocket.OPEN) return;
    const text = JSON.stringify({
      jsonrpc: "2.0",
      method: "events.connection",
      params: snapshot(),
    });
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
          case "devices.status":
            result = await deviceStatus.read();
            break;
          case "devices.list":
            result = await connector.list();
            break;
          case "devices.run":
            if (typeof params.deviceId !== "string" || typeof params.action !== "string")
              throw new RpcError(-32602, "A device ID and action are required.");
            result = await connector.run(params.deviceId, params.action, params.args ?? {});
            break;
          case "devices.runBinary": {
            if (typeof params.deviceId !== "string" || typeof params.action !== "string")
              throw new RpcError(-32602, "A device ID and action are required.");
            const reply = await connector.runBinary(
              params.deviceId,
              params.action,
              params.args ?? {},
              input ?? new Uint8Array(),
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
            // The controller exists before the first await. A client that disconnects during the
            // capability probe below then cancels the copy instead of leaving it to run unowned.
            const controller = new AbortController();
            peer.copies.add(controller);
            if (peer.socket.readyState !== WebSocket.OPEN) controller.abort();
            const canceled = () =>
              actionError("canceled", "The client disconnected. The copy did not start.");
            let last = 0;
            try {
              if (controller.signal.aborted) {
                result = canceled();
                break;
              }
              const info = await connector.run(request.deviceId, "system.info", {});
              if (controller.signal.aborted) {
                result = canceled();
                break;
              }
              if (!info.ok) {
                result = info;
                break;
              }
              if (!isRecord(info.result) || info.result.transferVersion !== TRANSFER_VERSION) {
                result = actionError(
                  "unsupported_device",
                  "The device runs a rome-node version without file transfers. Update rome-node on that device.",
                );
                break;
              }
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
              result = { type: "response", ok: true, result: summary };
            } catch (cause) {
              if (!(cause instanceof TransferError)) throw cause;
              result = actionError(cause.code, cause.message);
            } finally {
              peer.copies.delete(controller);
            }
            break;
          }
          case "events.subscribe":
          case "events.unsubscribe":
            if (params.topic !== "connection") throw new RpcError(-32602, "Unknown event topic.");
            peer.subscribed = value.method === "events.subscribe";
            // Register and send the first snapshot in one turn, before yielding or acknowledging.
            if (peer.subscribed) notify(peer);
            result = { subscribed: peer.subscribed };
            break;
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
    signal.removeEventListener("abort", close);
    // A successor replaces discovery after binding. Removing it here could erase the new owner.
  }
}
