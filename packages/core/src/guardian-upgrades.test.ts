import { createServer, request, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "@rstest/core";
import { attachDesktopProxy } from "./desktop-proxy-server.js";
import { attachLiveEventsServer, type LiveEventSources } from "./live-events-server.js";
import { attachNodeConsoleServer } from "./node-console-server.js";
import { DashboardAccessState } from "./lib/dashboard-access-state.js";
import { attachTerminalServer } from "./terminal-server.js";
import { guardianAuth } from "./db/schema.js";
import { createTestDb, type TestDb } from "./test/helpers.js";
import { createSession } from "./lib/auth.js";
import { createNodeConfig } from "@rome-os/node-core/client";
import { tmpdir } from "node:os";
import { join } from "node:path";

function listen(server: ReturnType<typeof createServer>): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port));
  });
}

function close(server: ReturnType<typeof createServer>): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

const noSources: LiveEventSources = {
  subscribeChatStatus: () => () => {},
  hasChatSession: async () => false,
  subscribeChatSession: () => () => {},
  subscribeAppCatalog: () => () => {},
};

function attachAll(server: ReturnType<typeof createServer>, db: TestDb["db"]) {
  const handlers = [
    attachDesktopProxy(server, db),
    attachTerminalServer(server, db),
    attachLiveEventsServer(server, db, new DashboardAccessState(), noSources),
    attachNodeConsoleServer(server, db, () =>
      createNodeConfig({ directory: join(tmpdir(), "rome-node-console-unconfigured") }),
    ),
  ];
  return { close: () => handlers.forEach((handler) => handler.close()) };
}

/** Sends through a reverse proxy unless `direct`, which connects as a loopback caller. */
function upgrade(
  port: number,
  path: string,
  headers: Record<string, string>,
  { direct = false } = {},
): Promise<number> {
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
        ...(direct ? {} : { "x-forwarded-for": "203.0.113.1" }),
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
    "/ws/events",
    "/ws/node",
  ])("owns socket errors before checking %s", async (path) => {
    const testDb = createTestDb();
    const server = createServer();
    const handlers = attachAll(server, testDb.db);
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
      handlers.close();
      testDb.close();
    }
  });

  it("blocks anonymous and cross-origin requests before reaching websockify, the terminal, live events, or the node console", async () => {
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
    const handlers = attachAll(server, testDb.db);
    const paths = [
      "/desktop-proxy/websockify",
      "/ws/terminal?preset=claude-login",
      "/ws/events",
      "/ws/node",
    ];

    try {
      const port = await listen(server);
      for (const path of paths) {
        expect(await upgrade(port, path, {})).toBe(401);
        // A page the in-container browser visits reaches loopback directly.
        expect(
          await upgrade(port, path, { origin: "https://evil.example" }, { direct: true }),
        ).toBe(403);
      }
      expect(upstreamConnections).toBe(0);
      expect(
        await upgrade(port, "/ws/events", { origin: `http://127.0.0.1:${port}` }, { direct: true }),
      ).toBe(101);
      expect(
        await upgrade(port, "/ws/node", { origin: `http://127.0.0.1:${port}` }, { direct: true }),
      ).toBe(101);

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
      handlers.close();
      await close(server);
      await close(upstream);
      testDb.close();
      if (previousPort === undefined) delete process.env.ROME_NOVNC_PORT;
      else process.env.ROME_NOVNC_PORT = previousPort;
    }
  });
});
