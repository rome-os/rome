import WebSocket from "ws";
import { MAX_MESSAGE_BYTES } from "./protocol.js";
import type { ClientSocket } from "./client.js";

export function createNodeSocket(url: string, authorization: string): ClientSocket {
  const socket = new WebSocket(url, {
    headers: { Authorization: authorization },
    handshakeTimeout: 10_000,
    maxPayload: MAX_MESSAGE_BYTES,
    followRedirects: false,
  });
  let alive = true;
  const heartbeat = setInterval(() => {
    if (socket.readyState !== WebSocket.OPEN) return;
    if (!alive) {
      socket.terminate();
      return;
    }
    alive = false;
    socket.ping();
  }, 30_000);
  heartbeat.unref();
  socket.on("pong", () => {
    alive = true;
  });
  socket.on("close", () => clearInterval(heartbeat));
  return socket;
}
