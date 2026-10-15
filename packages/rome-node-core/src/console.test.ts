import { afterEach, describe, expect, it } from "@rstest/core";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { openConsoleBridge } from "./console.js";
import { serveDaemon } from "./daemon.js";
import { createNodeConfig, type NodeConfig } from "./local.js";
import { writePrivateJson } from "./storage.js";
import { findDaemon } from "./daemon-control.js";

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const clean of cleanup.splice(0).reverse()) await clean();
});

async function freePort() {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  if (!address || typeof address === "string") throw new Error("Missing address");
  return address.port;
}

async function directory() {
  const path = await mkdtemp(join(tmpdir(), "rome-node-console-"));
  cleanup.push(() => rm(path, { recursive: true, force: true }));
  return path;
}

async function daemon() {
  const dir = await directory();
  await writePrivateJson(join(dir, "caller.json"), {
    cloudUrl: "http://127.0.0.1:9",
    token: `romedev_${"a".repeat(43)}`,
  });
  const config = createNodeConfig({ directory: dir, port: await freePort() });
  const controller = new AbortController();
  const serving = serveDaemon(config, controller.signal);
  cleanup.push(async () => {
    controller.abort();
    await serving;
  });
  for (let attempt = 0; attempt < 100; attempt++) {
    const found = await findDaemon(config).catch(() => null);
    if (found) {
      found.rpc.close();
      return { config, stop: () => controller.abort() };
    }
    await delay(20);
  }
  throw new Error("Daemon did not start");
}

function client(config: NodeConfig) {
  const messages: Record<string, unknown>[] = [];
  let closed = false;
  const bridge = openConsoleBridge(config, {
    send: (text) => messages.push(JSON.parse(text)),
    close: () => {
      closed = true;
    },
  });
  cleanup.push(async () => bridge.close());
  const until = async (test: () => boolean) => {
    for (let attempt = 0; attempt < 200 && !test(); attempt++) await delay(10);
    if (!test()) throw new Error("Timed out");
  };
  return { bridge, messages, closed: () => closed, until };
}

describe("openConsoleBridge", () => {
  it("forwards observation methods and refuses everything else", async () => {
    const { config } = await daemon();
    const c = client(config);
    c.bridge.receive(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "node.status" }));
    c.bridge.receive(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "daemon.stop" }));
    c.bridge.receive(JSON.stringify({ jsonrpc: "2.0", id: 3, method: "devices.run", params: {} }));
    c.bridge.receive(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 4,
        method: "events.subscribe",
        params: { topic: "connection" },
      }),
    );
    c.bridge.receive(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 5,
        method: "events.subscribe",
        params: { topic: "node" },
      }),
    );
    c.bridge.receive(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 6,
        method: "log.stats",
        params: { since: Date.now() - 60_000, bucketMs: 10_000 },
      }),
    );
    await c.until(() => c.messages.filter((message) => "id" in message).length === 6);
    const byId = new Map(c.messages.filter((m) => "id" in m).map((m) => [m.id, m]));
    expect(byId.get(1)).toMatchObject({ result: { roles: { caller: {} } } });
    expect(byId.get(6)).toMatchObject({ result: { bucketMs: 10_000, groups: [] } });
    for (const id of [2, 3, 4]) expect(byId.get(id)).toMatchObject({ error: { code: -32601 } });
    // The snapshot arrives before the acknowledgement.
    const snapshot = c.messages.findIndex((m) => m.method === "events.node");
    expect(snapshot).toBeGreaterThan(-1);
    expect(snapshot).toBeLessThan(c.messages.indexOf(byId.get(5)!));
    expect(c.closed()).toBe(false);
  });

  it("reports a missing daemon and closes", async () => {
    const dir = await directory();
    const config = createNodeConfig({ directory: dir, port: await freePort() });
    const c = client(config);
    await c.until(c.closed);
    expect(c.messages).toEqual([
      { jsonrpc: "2.0", method: "console.daemon", params: { state: "not_configured" } },
    ]);
  });

  it("closes when the daemon stops", async () => {
    const { config, stop } = await daemon();
    const c = client(config);
    c.bridge.receive(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "node.status" }));
    await c.until(() => c.messages.length === 1);
    stop();
    await c.until(c.closed);
    expect(c.messages.at(-1)).toEqual({
      jsonrpc: "2.0",
      method: "console.daemon",
      params: { state: "disconnected" },
    });
  });
});
