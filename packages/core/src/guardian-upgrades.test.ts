import { createServer, request, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "@rstest/core";
import { attachDesktopProxy } from "./desktop-proxy-server.js";
import { attachTerminalServer } from "./terminal-server.js";
import { guardianAuth } from "./db/schema.js";
import { createTestDb } from "./test/helpers.js";
import { createSession } from "./lib/auth.js";

function listen(server: ReturnType<typeof createServer>): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port));
  });
}

function close(server: ReturnType<typeof createServer>): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

function upgrade(port: number, path: string, headers: Record<string, string>): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = request({
      hostname: "127.0.0.1",
      port,
      path,
      headers: {
        connection: "Upgrade",
        upgrade: "websocket",
        "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==",
        "sec-websocket-version": "13",
        "x-forwarded-for": "203.0.113.1",
        ...headers,
      },
    });
    req.on("upgrade", (response, socket) => {
      socket.destroy();
      resolve(response.statusCode ?? 0);
    });
    req.on("response", (response) => {
      response.resume();
      resolve(response.statusCode ?? 0);
    });
    req.on("error", reject);
    req.setTimeout(3_000, () => req.destroy(new Error("upgrade timed out")));
    req.end();
  });
}

describe("guardian WebSocket upgrade handlers", () => {
  it.each([
    "/desktop-proxy/websockify",
    "/ws/terminal?preset=claude-login",
  ])("owns socket errors before checking %s", async (path) => {
    const testDb = createTestDb();
    const server = createServer();
    const desktop = attachDesktopProxy(server, testDb.db);
    const terminal = attachTerminalServer(server, testDb.db);
    const socket = new PassThrough();
    const req = {
      url: path,
      headers: { host: "rome.example", "x-forwarded-for": "203.0.113.1" },
      socket,
    } as unknown as IncomingMessage;

    try {
      server.emit("upgrade", req, socket, Buffer.alloc(0));
      expect(socket.listenerCount("error")).toBeGreaterThan(0);
      const closed = new Promise<void>((resolve) => socket.once("close", () => resolve()));
      socket.destroy(new Error("read ECONNRESET"));
      await closed;
    } finally {
      desktop.close();
      terminal.close();
      testDb.close();
    }
  });

  it("blocks anonymous and cross-origin requests before reaching websockify or the terminal", async () => {
    const testDb = createTestDb();
    await testDb.db.insert(guardianAuth).values({
      id: "auth-1",
      userId: "guardian-1",
      passwordHash: "irrelevant",
      createdAt: new Date(),
    });
    const upstream = createServer();
    let upstreamConnections = 0;
    upstream.on("upgrade", (_req, socket) => {
      upstreamConnections++;
      socket.end(
        "HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n",
      );
    });
    const upstreamPort = await listen(upstream);
    const previousPort = process.env.ROME_NOVNC_PORT;
    process.env.ROME_NOVNC_PORT = String(upstreamPort);
    const server = createServer();
    const desktop = attachDesktopProxy(server, testDb.db);
    const terminal = attachTerminalServer(server, testDb.db);

    try {
      const port = await listen(server);
      expect(await upgrade(port, "/desktop-proxy/websockify", {})).toBe(401);
      expect(await upgrade(port, "/ws/terminal?preset=claude-login", {})).toBe(401);
      expect(upstreamConnections).toBe(0);

      const cookie = `rome_session=${createSession("guardian-1")}`;
      expect(
        await upgrade(port, "/desktop-proxy/websockify", {
          cookie,
          origin: "http://other.rome.example",
          "x-forwarded-host": "rome.example",
          "x-forwarded-proto": "http",
        }),
      ).toBe(403);
      expect(upstreamConnections).toBe(0);

      expect(
        await upgrade(port, "/desktop-proxy/websockify", {
          cookie,
          origin: "http://rome.example",
          "x-forwarded-host": "rome.example",
          "x-forwarded-proto": "http",
        }),
      ).toBe(101);
      expect(upstreamConnections).toBe(1);
    } finally {
      desktop.close();
      terminal.close();
      await close(server);
      await close(upstream);
      testDb.close();
      if (previousPort === undefined) delete process.env.ROME_NOVNC_PORT;
      else process.env.ROME_NOVNC_PORT = previousPort;
    }
  });
});
