import { describe, it, expect, beforeAll, afterAll } from "@rstest/core";
import { createServer, type Server } from "node:http";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { AddressInfo } from "node:net";
import { WebSocket } from "ws";
import { attachAppWebSocket, type AppWebSocketDeps } from "./websocket-server.js";
import type { AppCatalog } from "./catalog.js";
import type { ResolvedApp } from "./state.js";
import type { CatalogEvent, SubscriberHandler } from "./state.js";
import { createTestDb } from "../test/helpers.js";

const fixturePath = join(dirname(fileURLToPath(import.meta.url)), "__fixtures__/ws-echo-api.mjs");

/** Minimal resolved app pointing the dispatcher at the echo fixture. */
const echoApp = {
  appId: "echo",
  manifest: { id: "echo", version: "0.0.0", description: "ws echo fixture" },
  api: { entryPath: fixturePath },
  db: null,
} as unknown as ResolvedApp;

function makeFakeCatalog(): {
  catalog: AppCatalog;
  fire: (event: CatalogEvent) => void;
} {
  const subscribers: SubscriberHandler[] = [];
  const catalog = {
    get: (appId: string) => (appId === "echo" ? echoApp : undefined),
    subscribe: (handler: SubscriberHandler) => {
      subscribers.push(handler);
      return () => {
        const i = subscribers.indexOf(handler);
        if (i >= 0) subscribers.splice(i, 1);
      };
    },
  } as unknown as AppCatalog;
  return {
    catalog,
    fire: (event) => {
      for (const handler of subscribers) void handler(event);
    },
  };
}

function waitForMessage(ws: WebSocket): Promise<string> {
  return new Promise((resolve, reject) => {
    ws.once("message", (raw) => resolve(raw.toString()));
    ws.once("error", reject);
  });
}

function waitForClose(ws: WebSocket): Promise<number> {
  return new Promise((resolve) => ws.once("close", (code) => resolve(code)));
}

const testDb = createTestDb();

describe("attachAppWebSocket", () => {
  let server: Server;
  let port: number;
  let handle: { close(): void };
  let fire: (event: CatalogEvent) => void;

  // The server requires a same-origin handshake (CSWSH guard). Browsers always
  // send Origin on WS upgrades, so simulate a same-origin browser client.
  function appWs(path: string): WebSocket {
    return new WebSocket(`ws://127.0.0.1:${port}${path}`, {
      headers: { origin: `http://127.0.0.1:${port}` },
    });
  }

  beforeAll(async () => {
    const fake = makeFakeCatalog();
    fire = fake.fire;
    const deps = {
      appCatalog: fake.catalog,
      // A real (empty) DB: the upgrade path resolves `request.caller`, whose
      // trusted-loopback branch reads guardian_auth. Empty table = no guardian
      // seat, so an in-container upgrade resolves as anonymous here.
      db: testDb.db,
      actionEngine: {} as never,
      routinesRepo: undefined,
      appRuntimeRepositories: {} as never,
    } satisfies AppWebSocketDeps;

    server = createServer();
    handle = attachAppWebSocket(server, deps);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    port = (server.address() as AddressInfo).port;
  });

  afterAll(async () => {
    testDb.close();
    handle.close();
    // Force-close lingering sockets. The deliberately-unhandled non-app upgrade
    // (below) leaves a socket Node no longer tracks once `upgrade` fired, so
    // server.close() can wait on it forever — race a short fallback.
    server.closeAllConnections?.();
    await Promise.race([
      new Promise<void>((resolve) => server.close(() => resolve())),
      new Promise<void>((resolve) => setTimeout(resolve, 2000)),
    ]);
  });

  it("completes the upgrade and echoes messages", async () => {
    const ws = appWs("/api/apps/echo/live");
    // Attach the message listener up front — the server sends "ready" the
    // instant the handshake completes, so awaiting "open" first would race it.
    expect(await waitForMessage(ws)).toBe("ready");

    const echoed = waitForMessage(ws);
    ws.send("ping");
    expect(await echoed).toBe("echo:ping");

    ws.close();
    await waitForClose(ws);
  });

  it("closes live connections when the app's catalog entry changes", async () => {
    const ws = appWs("/api/apps/echo/live");
    await waitForMessage(ws); // "ready" — connection is live

    const closed = waitForClose(ws);
    fire({ appId: "echo", change: "changed", current: echoApp });
    expect(await closed).toBe(1012); // Service Restart
  });

  it("rejects an upgrade the app handler does not accept (426)", async () => {
    const ws = appWs("/api/apps/echo/other");
    const err = await new Promise<Error>((resolve) => ws.once("error", resolve));
    expect(err.message).toMatch(/426/);
  });

  it("rejects a cross-origin upgrade (403 — CSWSH guard)", async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/api/apps/echo/live`, {
      headers: { origin: "http://evil.example" },
    });
    const err = await new Promise<Error>((resolve) => ws.once("error", resolve));
    expect(err.message).toMatch(/403/);
  });

  it("ignores upgrades on non-app paths (never completes the handshake)", async () => {
    // Path the matcher doesn't own — our listener returns without touching the
    // socket, so with no other handler the upgrade simply never completes.
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/something-else`);
    let opened = false;
    ws.once("open", () => {
      opened = true;
    });
    ws.on("error", () => {}); // swallow the reset on terminate()
    // Give it a short window; the handshake must not succeed.
    await new Promise<void>((resolve) => setTimeout(resolve, 300));
    expect(opened).toBe(false);
    ws.terminate();
  });
});
