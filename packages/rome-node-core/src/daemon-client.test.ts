import { afterEach, describe, expect, it } from "@rstest/core";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocketServer, type WebSocket } from "ws";
import { setTimeout as delay } from "node:timers/promises";
import {
  createNodeClient,
  createNodeConfig,
  DaemonVersionError,
  startDaemon,
  stopDaemon,
} from "./daemon-client.js";
import { writePrivateJson } from "./storage.js";

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const clean of cleanup.splice(0).reverse()) await clean();
});

async function fixture(handle: (req: IncomingMessage, res: ServerResponse) => void) {
  const directory = await mkdtemp(join(tmpdir(), "rome-node-client-"));
  cleanup.push(() => rm(directory, { force: true, recursive: true }));
  const server = createServer(handle);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanup.push(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing listener address");
  const config = createNodeConfig({ directory, port: address.port });
  await writePrivateJson(join(directory, "daemon.json"), {
    pid: process.pid,
    port: address.port,
    token: `romenode_${"a".repeat(43)}`,
  });
  return { config, server };
}

async function rpcFixture(
  handle?: (method: string, params: { args?: { order?: number } }, socket: WebSocket) => unknown,
) {
  const f = await fixture((_req, res) => res.writeHead(426).end());
  const sockets = new WebSocketServer({ server: f.server });
  cleanup.push(async () => {
    for (const socket of sockets.clients) socket.terminate();
    await new Promise<void>((resolve) => sockets.close(() => resolve()));
  });
  await writePrivateJson(join(f.config.directory, "daemon.json"), {
    pid: process.pid,
    port: f.config.port,
    token: `romenode_${"a".repeat(43)}`,
    protocolVersion: 2,
  });
  const status = { pid: process.pid, protocolVersion: 2, connection: "online", token: "private" };
  let subscriptions = 0;
  sockets.on("connection", (socket) =>
    socket.on("message", async (data) => {
      const request = JSON.parse(data.toString());
      let result = handle ? await handle(request.method, request.params, socket) : undefined;
      if (request.method === "events.subscribe") {
        subscriptions++;
        socket.send(
          JSON.stringify({ jsonrpc: "2.0", method: "events.connection", params: status }),
        );
        result = { subscribed: true };
      }
      if (socket.readyState === 1)
        socket.send(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: result ?? status }));
    }),
  );
  const client = createNodeClient(f.config);
  cleanup.push(async () => client.disconnect());
  return { ...f, sockets, client, subscriptions: () => subscriptions };
}

async function until(predicate: () => boolean) {
  const deadline = Date.now() + 5000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("Condition timed out");
    await delay(10);
  }
}

describe("caller client boundaries", () => {
  it("rejects an older daemon without replacing it and allows an explicit stop", async () => {
    let stops = 0;
    const f = await fixture((req, res) => {
      if (req.url === "/stop") {
        stops++;
        res.end("{}");
        f.server.close();
      } else res.end(JSON.stringify({ pid: process.pid }));
    });
    await expect(startDaemon(f.config)).rejects.toBeInstanceOf(DaemonVersionError);
    expect(stops).toBe(0);
    await stopDaemon(f.config);
    expect(stops).toBe(1);
  });

  it("restores subscriptions without replaying an action whose local response was lost", async () => {
    let requests = 0;
    const f = await rpcFixture((method, _params, socket) => {
      if (method === "devices.run") {
        requests++;
        socket.terminate();
      }
    });
    const events: unknown[] = [];
    await f.client.subscribe("connection", (event) => events.push(event));
    expect(events).toHaveLength(1);
    expect(await f.client.run("target", "exec", { command: "side-effect" })).toMatchObject({
      ok: false,
      error: { code: "unknown_outcome" },
    });
    await until(() => events.length === 3);
    expect(f.subscriptions()).toBe(2);
    expect(events).toEqual([
      {
        transport: "connected",
        daemon: { pid: process.pid, protocolVersion: 2, connection: "online" },
      },
      { transport: "disconnected", daemon: null, reason: "connection_lost" },
      {
        transport: "connected",
        daemon: { pid: process.pid, protocolVersion: 2, connection: "online" },
      },
    ]);
    expect(requests).toBe(1);
  });

  it("rejects non-JSON input before discovery and strips credentials from status", async () => {
    let requests = 0;
    const f = await rpcFixture(() => {
      requests++;
    });
    expect(await f.client.run("target", "exec", { number: 1n })).toMatchObject({
      ok: false,
      error: { code: "invalid_request" },
    });
    expect(requests).toBe(0);
    expect(await f.client.getConnectionStatus()).toEqual({
      pid: process.pid,
      protocolVersion: 2,
      connection: "online",
    });
    f.client.disconnect();
    await expect(f.client.listDevices()).rejects.toThrow("closed");
    expect(requests).toBe(2);
  });

  it("stops reconnection on protocol mismatch and reports unavailable state", async () => {
    let incompatible = false;
    let handshakes = 0;
    const f = await rpcFixture((method) => {
      if (method === "daemon.hello") {
        handshakes++;
        if (incompatible) return { pid: process.pid, protocolVersion: 99, connection: "online" };
      }
    });
    const events: unknown[] = [];
    await f.client.subscribe("connection", (event) => events.push(event));
    incompatible = true;
    for (const socket of f.sockets.clients) socket.terminate();
    await until(() => events.length === 3);
    expect(events.at(-1)).toEqual({
      transport: "disconnected",
      daemon: null,
      reason: "incompatible",
    });
    await expect(f.client.getConnectionStatus()).rejects.toBeInstanceOf(DaemonVersionError);
    await delay(600);
    expect(handshakes).toBe(2);
  });

  it("matches concurrent responses independently of arrival order", async () => {
    const f = await rpcFixture(async (method, params) => {
      if (method === "devices.run") {
        await delay(params.args?.order === 1 ? 50 : 1);
        return { type: "response", ok: true, result: params.args };
      }
    });
    const results = await Promise.all(
      [1, 2, 3].map((order) => f.client.run("target", "exec", { order })),
    );
    expect(results.map((result) => result.ok && result.result)).toEqual([
      { order: 1 },
      { order: 2 },
      { order: 3 },
    ]);
    expect(f.sockets.clients.size).toBe(1);
  });

  it("keeps other listeners subscribed and disconnects only the local client", async () => {
    const f = await rpcFixture();
    const first: unknown[] = [];
    const second: unknown[] = [];
    const unsubscribe = await f.client.subscribe("connection", (event) => first.push(event));
    await f.client.subscribe("connection", (event) => second.push(event));
    await unsubscribe();
    const count = first.length;
    for (const socket of f.sockets.clients) socket.terminate();
    await until(() => second.length === 3);
    expect(f.subscriptions()).toBe(3);
    expect(first).toHaveLength(count);
    expect(second.at(-2)).toMatchObject({ transport: "disconnected", daemon: null });
    expect(second.at(-1)).toMatchObject({ transport: "connected" });
    f.client.disconnect();
    await delay(350);
    expect(f.subscriptions()).toBe(3);
  });
});
