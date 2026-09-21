import WebSocket from "ws";
import type { ClientSocket } from "./client.js";

export function createNodeSocket(url: string, authorization: string): ClientSocket {
  const socket = new WebSocket(url, {
    headers: { Authorization: authorization },
    handshakeTimeout: 10_000,
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
