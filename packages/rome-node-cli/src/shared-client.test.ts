import { afterEach, describe, expect, it } from "@rstest/core";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { WebSocketServer } from "ws";
import {
  createNodeClient,
  createNodeConfig,
  stopDaemon,
  type ConnectionEvent,
} from "@rome-os/node-core/client";
import { writePrivateJson } from "@rome-os/node-core/storage";

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const clean of cleanup.splice(0).reverse()) await clean();
});

async function fixture(dropReply = false) {
  const root = await mkdtemp(join(tmpdir(), "rome-node-shared-"));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const token = `romedev_${"a".repeat(43)}`;
  const gateway = createServer();
  const sockets = new WebSocketServer({ server: gateway });
  let connections = 0;
  let requests = 0;
  sockets.on("connection", (socket, request) => {
    if (request.headers.authorization !== `Bearer ${token}`) {
      socket.close(4001);
      return;
    }
    connections++;
    socket.on("message", (data) => {
      requests++;
      const request = JSON.parse(data.toString());
      if (dropReply) {
        socket.close(4001);
        return;
      }
      socket.send(
        JSON.stringify({
          id: request.id,
          from: request.to,
          payload: {
            type: "response",
            ok: true,
            result: { action: request.payload.action, args: request.payload.args },
          },
        }),
      );
    });
  });
  await new Promise<void>((resolve) => gateway.listen(0, "127.0.0.1", resolve));
  cleanup.push(async () => {
    for (const socket of sockets.clients) socket.terminate();
    await new Promise<void>((resolve) => sockets.close(() => resolve()));
    await new Promise<void>((resolve) => gateway.close(() => resolve()));
  });
  const address = gateway.address();
  if (!address || typeof address === "string") throw new Error("Missing Gateway address");
  const cloud = createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    if (req.headers.authorization !== `Bearer ${token}`) res.writeHead(401).end("{}");
    else if (req.url === "/v1/gateway/config")
      res.end(JSON.stringify({ gatewayUrl: `ws://127.0.0.1:${address.port}` }));
    else res.end(JSON.stringify({ items: [{ id: "target" }] }));
  });
  await new Promise<void>((resolve) => cloud.listen(0, "127.0.0.1", resolve));
  cleanup.push(() => new Promise<void>((resolve) => cloud.close(() => resolve())));
  const cloudAddress = cloud.address();
  if (!cloudAddress || typeof cloudAddress === "string") throw new Error("Missing Cloud address");
  const config = createNodeConfig({ directory: root });
  await writePrivateJson(join(root, "caller.json"), {
    cloudUrl: `http://127.0.0.1:${cloudAddress.port}`,
    token,
  });
  cleanup.push(() => stopDaemon(config));

  function run(args: string[]) {
    return new Promise<{ code: number | null; stdout: string; stderr: string }>(
      (resolve, reject) => {
        const child = spawn(process.execPath, args, {
          env: { ...process.env, ROME_NODE_CONFIG_DIR: root },
          stdio: ["ignore", "pipe", "pipe"],
          windowsHide: true,
        });
        let stdout = "";
        let stderr = "";
        child.stdout.on("data", (data) => {
          stdout += data;
        });
        child.stderr.on("data", (data) => {
          stderr += data;
        });
        const timer = setTimeout(() => {
          child.kill();
          reject(new Error("Client timed out"));
        }, 20000);
        child.once("error", (error) => {
          clearTimeout(timer);
          reject(error);
        });
        child.once("close", (code) => {
          clearTimeout(timer);
          resolve({ code, stdout, stderr });
        });
      },
    );
  }
  const cli = (...args: string[]) => run([resolve("bin/rome-node.js"), ...args]);
  const api = (body: string) =>
    run([
      "--input-type=module",
      "-e",
      `
    import { createNodeClient, nodeConfigFromEnvironment } from '@rome-os/node-core/client';
    const client = createNodeClient(nodeConfigFromEnvironment(process.env));
    ${body}
    client.disconnect();
  `,
    ]);
  function watch() {
    const events: ConnectionEvent[] = [];
    const child = spawn(process.execPath, [resolve("bin/rome-node.js"), "watch"], {
      env: { ...process.env, ROME_NODE_CONFIG_DIR: root },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let buffer = "";
    child.stdout.on("data", (data) => {
      buffer += data.toString();
      const lines = buffer.split("\n");
      buffer = lines.pop()!;
      events.push(...lines.map((line) => JSON.parse(line)));
    });
    const exited = new Promise<number | null>((resolve) => child.once("close", resolve));
    cleanup.push(async () => {
      child.kill();
      await exited;
    });
    return { events, child, exited };
  }
  return { config, cli, api, watch, connections: () => connections, requests: () => requests };
}

async function until(predicate: () => boolean) {
  const deadline = Date.now() + 8000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("Condition timed out");
    await delay(10);
  }
}

describe("CLI and JavaScript clients sharing one caller daemon", () => {
  it("starts from the JS API without a CLI entrypoint, shares one Gateway connection, and survives client exit", async () => {
    const f = await fixture();
    const client = createNodeClient(f.config);
    expect(await client.getConnectionStatus()).toBeNull();
    const first = await f.api(`
      console.log(JSON.stringify(await client.describe('target')));
      console.log(JSON.stringify(await client.getConnectionStatus()));
    `);
    expect(first.code).toBe(0);
    const [description, initialStatus] = first.stdout
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(description).toMatchObject({ ok: true, result: { action: "system.info" } });
    expect(initialStatus).toMatchObject({ protocolVersion: 2, connection: "online" });
    const responses = await Promise.all([
      f.cli("device", "run", "target", "exec", "--args", '{"command":"from-cli"}'),
      f.api(
        `console.log(JSON.stringify(await client.run('target', 'exec', { command: 'from-api' })));`,
      ),
      f.cli("device"),
    ]);
    for (const response of responses) expect(response.code).toBe(0);
    expect(JSON.parse(responses[0].stdout)).toMatchObject({
      result: { args: { command: "from-cli" } },
    });
    expect(JSON.parse(responses[1].stdout)).toMatchObject({
      result: { args: { command: "from-api" } },
    });
    expect(await client.getConnectionStatus()).toEqual(initialStatus);
    expect(f.connections()).toBe(1);
    expect(f.requests()).toBe(3);
    client.disconnect();
    expect((await f.cli("device", "describe", "target")).code).toBe(0);
    expect(f.connections()).toBe(1);
  }, 30000);

  it("arbitrates simultaneous CLI and JS startup without replacing the winning daemon", async () => {
    const f = await fixture();
    const results = await Promise.all([
      f.cli("device", "describe", "target"),
      f.api(`console.log(JSON.stringify(await client.describe('target')));`),
      f.api(`console.log(JSON.stringify(await client.describe('target')));`),
    ]);
    for (const result of results) {
      expect(result.code).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({ ok: true });
    }
    expect(f.connections()).toBe(1);
    expect(f.requests()).toBe(3);
  }, 30000);

  it("pushes snapshots to CLI and API observers while requests run, and restores them after daemon replacement", async () => {
    const f = await fixture();
    await f.cli("daemon", "start");
    const client = createNodeClient(f.config);
    cleanup.push(async () => client.disconnect());
    const events: ConnectionEvent[] = [];
    const unsubscribe = await client.subscribe("connection", (event) => events.push(event));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ transport: "connected", daemon: { connection: "stopped" } });
    const pid = events[0]!.daemon!.pid;
    const watcher = f.watch();
    await until(() => watcher.events.length > 0);
    const responses = await Promise.all([
      client.run("target", "exec", { client: "api" }),
      f.cli("device", "run", "target", "exec", "--args", '{"client":"cli"}'),
    ]);
    expect(responses[0]).toMatchObject({ ok: true, result: { args: { client: "api" } } });
    expect(JSON.parse(responses[1].stdout)).toMatchObject({
      ok: true,
      result: { args: { client: "cli" } },
    });
    await until(() => watcher.events.some((event) => event.daemon?.connection === "online"));
    expect(events.map((event) => event.daemon?.connection)).toEqual([
      "stopped",
      "connecting",
      "online",
    ]);
    expect(watcher.events.map((event) => event.daemon?.connection)).toEqual([
      "stopped",
      "connecting",
      "online",
    ]);
    expect(f.connections()).toBe(1);
    process.kill(pid, "SIGKILL");
    await until(
      () =>
        events.at(-1)?.transport === "disconnected" &&
        watcher.events.at(-1)?.transport === "disconnected",
    );
    expect(events.at(-1)!.daemon).toBeNull();
    await f.cli("daemon", "start");
    await until(
      () =>
        events.at(-1)?.transport === "connected" &&
        watcher.events.at(-1)?.transport === "connected",
    );
    expect(events.at(-1)!.daemon).toMatchObject({ connection: "stopped" });
    expect(events.at(-1)!.daemon!.pid).not.toBe(pid);
    expect(f.requests()).toBe(2);
    const unsubscribeCount = events.length;
    await unsubscribe();
    expect((await f.cli("device", "describe", "target")).code).toBe(0);
    await until(() => watcher.events.at(-1)?.daemon?.connection === "online");
    expect(events).toHaveLength(unsubscribeCount);
    expect(f.connections()).toBe(2);
    watcher.child.kill("SIGINT");
    if (process.platform !== "win32") expect(await watcher.exited).toBe(0);
    expect(await client.getConnectionStatus()).toMatchObject({ connection: "online" });
  }, 30000);

  it("does not let a subscribed observer restart an explicitly stopped daemon", async () => {
    const f = await fixture();
    await f.cli("daemon", "start");
    const client = createNodeClient(f.config);
    cleanup.push(async () => client.disconnect());
    const events: ConnectionEvent[] = [];
    await client.subscribe("connection", (event) => events.push(event));
    await stopDaemon(f.config);
    await until(() => events.at(-1)?.transport === "disconnected");
    await delay(1000);
    expect(await client.getConnectionStatus()).toBeNull();
    expect(JSON.parse((await f.cli("daemon", "status")).stdout)).toEqual({ running: false });
    expect(f.connections()).toBe(0);
  });

  it("reads device reachability over the shared daemon without replacing the CLI Gateway connection", async () => {
    const f = await fixture();
    expect((await f.cli("device", "describe", "target")).code).toBe(0);
    const status = await f.api(`console.log(JSON.stringify(await client.getDevicesStatus()));`);
    expect(status.code).toBe(0);
    expect(JSON.parse(status.stdout)).toMatchObject({
      connection: "online",
      devices: [{ id: "target", status: "connected" }],
    });
    expect(f.connections()).toBe(1);
    expect(f.requests()).toBe(2);
  });

  it("keeps device status polling passive before startup and after an explicit stop", async () => {
    const f = await fixture();
    const client = createNodeClient(f.config);
    cleanup.push(async () => client.disconnect());
    expect(await client.getDevicesStatus()).toBeNull();
    const initial = await f.api(`console.log(JSON.stringify(await client.getDevicesStatus()));`);
    expect(initial.code, initial.stderr).toBe(0);
    expect(JSON.parse(initial.stdout)).toBeNull();
    expect(JSON.parse((await f.cli("daemon", "status")).stdout)).toEqual({ running: false });
    expect(f.connections()).toBe(0);

    expect((await f.cli("daemon", "start")).code).toBe(0);
    expect(await client.getDevicesStatus()).toMatchObject({ connection: "online" });
    expect(f.connections()).toBe(1);
    await stopDaemon(f.config);
    expect(await client.getConnectionStatus()).toBeNull();
    for (let poll = 0; poll < 3; poll++) expect(await client.getDevicesStatus()).toBeNull();
    const afterStop = await f.api(`console.log(JSON.stringify(await client.getDevicesStatus()));`);
    expect(afterStop.code, afterStop.stderr).toBe(0);
    expect(JSON.parse(afterStop.stdout)).toBeNull();
    expect(JSON.parse((await f.cli("daemon", "status")).stdout)).toEqual({ running: false });
    expect(f.connections()).toBe(1);

    expect((await f.cli("device", "describe", "target")).code).toBe(0);
    expect(await client.getDevicesStatus()).toMatchObject({
      connection: "online",
      devices: [{ id: "target", status: "connected" }],
    });
    expect(f.connections()).toBe(2);
  }, 30000);

  it("returns unknown_outcome without replay when Gateway drops the response", async () => {
    const f = await fixture(true);
    const response = await f.api(
      `console.log(JSON.stringify(await client.run('target', 'exec', { command: 'side-effect' })));`,
    );
    expect(response.code).toBe(0);
    expect(JSON.parse(response.stdout)).toMatchObject({
      ok: false,
      error: { code: "unknown_outcome" },
    });
    expect(f.requests()).toBe(1);
  }, 30000);
});
