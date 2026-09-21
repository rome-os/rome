import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage } from "node:http";
import WebSocket, { WebSocketServer } from "ws";
import { isRecord } from "./actions.js";
import { DeviceConnector } from "./connector.js";
import { daemonStatePath, readCallerCredential, type NodeConfig } from "./local.js";
import { writePrivateJson } from "./storage.js";
import { DAEMON_PROTOCOL_VERSION, type DaemonStatus } from "./daemon-protocol.js";
import { DeviceStatusReader } from "./devices-status.js";
import { RpcError } from "./daemon-rpc.js";

interface Peer {
  socket: WebSocket;
  ready: boolean;
  subscribed: boolean;
  alive: boolean;
  pending: Set<string | number>;
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
  const sockets = new WebSocketServer({ noServer: true, perMessageDeflate: false });
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
  function notify(peer: Peer) {
    // A slow observer must not accumulate unbounded event data or block other clients.
    if (peer.socket.bufferedAmount > 1024 * 1024) {
      peer.socket.terminate();
      return;
    }
    send(peer, { jsonrpc: "2.0", method: "events.connection", params: snapshot() });
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
  async function dispatch(peer: Peer, value: unknown): Promise<unknown> {
    if (
      !isRecord(value) ||
      value.jsonrpc !== "2.0" ||
      typeof value.method !== "string" ||
      (Object.hasOwn(value, "id") &&
        typeof value.id !== "string" &&
        typeof value.id !== "number" &&
        value.id !== null)
    )
      return error(null, -32600, "Invalid Request");
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
      let result: unknown;
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
      return hasId ? { jsonrpc: "2.0", id, result } : undefined;
    } catch (cause) {
      if (!hasId) return;
      return cause instanceof RpcError
        ? error(id, cause.code, cause.message)
        : error(id, -32000, "The device service is unavailable.");
    } finally {
      if (hasId && id !== null) peer.pending.delete(id);
    }
  }
  sockets.on("connection", (socket) => {
    const peer: Peer = { socket, ready: false, subscribed: false, alive: true, pending: new Set() };
    peers.add(peer);
    socket.on("error", () => socket.terminate());
    socket.on("close", () => peers.delete(peer));
    socket.on("pong", () => {
      peer.alive = true;
    });
    socket.on("message", (data, binary) => {
      let request: unknown;
      try {
        request = JSON.parse(data.toString());
      } catch {
        send(peer, error(null, -32700, "Parse error"));
        return;
      }
      if (binary) {
        send(peer, error(null, -32600, "Invalid Request"));
        return;
      }
      void (async () => {
        if (Array.isArray(request) && request.length > 0) {
          const responses = (await Promise.all(request.map((item) => dispatch(peer, item)))).filter(
            (value) => value !== undefined,
          );
          if (responses.length) send(peer, responses);
        } else {
          const response = await dispatch(peer, request);
          if (response !== undefined) send(peer, response);
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
