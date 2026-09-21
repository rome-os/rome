import { expect, it } from "@rstest/core";
import { once } from "node:events";
import { WebSocketServer } from "ws";
import { createNodeSocket } from "./socket.js";

it("uses the WebSocket library's receive limit instead of imposing 32 MiB", async () => {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(server, "listening");
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("Expected a TCP address");
  const size = 33 * 1024 * 1024;
  server.on("connection", (peer) => peer.send("x".repeat(size)));
  const socket = createNodeSocket(`ws://127.0.0.1:${address.port}`, "Bearer test");
  try {
    const data = await new Promise<unknown>((resolve, reject) => {
      socket.addEventListener("message", (event) => resolve(event.data));
      socket.addEventListener("error", () => reject(new Error("WebSocket receive failed")));
    });
    expect(typeof data).toBe("string");
    expect((data as string).length).toBe(size);
  } finally {
    socket.close();
    for (const peer of server.clients) peer.terminate();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
}, 10000);
