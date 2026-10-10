import { afterEach, describe, expect, it } from "@rstest/core";
import { createServer } from "node:http";
import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import WebSocket, { WebSocketServer } from "ws";
import { serveDaemon } from "./daemon.js";
import { createNodeClient, createNodeConfig } from "./daemon-client.js";
import {
  DAEMON_PROTOCOL_VERSION,
  encodeBinaryMessage,
  parseBinaryMessage,
} from "./daemon-protocol.js";
import { decodeMeta, encodeFrame, encodeMeta, FRAME_TYPE, parseFrame } from "./frame.js";
import { writePrivateJson } from "./storage.js";
import { createExecutor } from "./executor.js";

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const clean of cleanup.splice(0).reverse()) await clean();
});

const target = "7c9e6679-7425-40de-944b-e07fc1f90ae7";
const offline = "16fd2706-8baf-433b-82eb-8c7fada847da";
/** Runs a real executor inside the fake Gateway. */
const device = "0f8fad5b-d9cb-469f-a165-70867728950e";
/** Answers system.info without transfer support. */
const older = "6ba7b810-9dad-41d1-80b4-00c04fd430c8";
const caller = "9b2e3c1a-5f4d-4e6a-8b7c-1d2e3f4a5b6c";

async function listen(server: ReturnType<typeof createServer>) {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanup.push(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing address");
  return address.port;
}

/** Runs a real daemon in this process against a fake Cloud and a Gateway that echoes frames. */
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "rome-node-daemon-"));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const token = `romedev_${"a".repeat(43)}`;
  const gateway = createServer();
  const sockets = new WebSocketServer({ server: gateway });
  const received: { binary: boolean; data: Buffer }[] = [];
  // While held, frames from the device queue up instead of reaching the caller.
  const gate = { hold: false, held: [] as Buffer[], forwarded: 0, holdAfter: Infinity };
  let callerSocket: WebSocket | undefined;
  const executor = createExecutor(
    "In-process device",
    (reply) => {
      callerSocket?.send(JSON.stringify({ id: reply.id, from: device, payload: reply.payload }));
      return true;
    },
    [],
    (frame) => {
      const bytes = Buffer.from(encodeFrame({ ...frame, peer: device }));
      if (gate.hold || gate.forwarded >= gate.holdAfter) gate.held.push(bytes);
      else {
        gate.forwarded++;
        callerSocket?.send(bytes);
      }
      return true;
    },
  );
  cleanup.push(async () => executor.disconnect());
  sockets.on("connection", (socket) =>
    socket.on("message", (data, binary) => {
      callerSocket = socket;
      const buffer = data as Buffer;
      received.push({ binary, data: buffer });
      if (!binary) {
        const envelope = JSON.parse(buffer.toString());
        if (envelope.to === device)
          void executor.receive({ id: envelope.id, from: caller, payload: envelope.payload });
        else if (envelope.to === older)
          socket.send(
            JSON.stringify({
              id: envelope.id,
              from: older,
              payload: { type: "response", ok: true, result: { frameVersion: 1 } },
            }),
          );
        else
          socket.send(
            JSON.stringify({ id: envelope.id, type: "error", code: "target_unavailable" }),
          );
        return;
      }
      const frame = parseFrame(buffer);
      if (!frame) return;
      if (frame.peer === device) {
        void executor.receiveFrame({ ...frame, peer: caller });
        return;
      }
      if (frame.peer === offline) {
        socket.send(
          encodeFrame({
            type: FRAME_TYPE.routeError,
            id: frame.id,
            peer: frame.peer,
            meta: encodeMeta({ code: "target_unavailable" }),
            body: new Uint8Array(),
          }),
        );
        return;
      }
      const request = decodeMeta(frame.meta);
      socket.send(
        encodeFrame({
          type: FRAME_TYPE.response,
          id: frame.id,
          peer: frame.peer,
          meta: encodeMeta({ type: "response", ok: true, result: { request } }),
          body: Buffer.from(frame.body).reverse(),
        }),
      );
    }),
  );
  cleanup.push(async () => {
    for (const socket of sockets.clients) socket.terminate();
    await new Promise<void>((resolve) => sockets.close(() => resolve()));
  });
  const gatewayPort = await listen(gateway);
  const cloud = createServer((_req, res) =>
    res.end(JSON.stringify({ gatewayUrl: `ws://127.0.0.1:${gatewayPort}` })),
  );
  const cloudPort = await listen(cloud);
  await writePrivateJson(join(directory, "caller.json"), {
    cloudUrl: `http://127.0.0.1:${cloudPort}`,
    token,
  });
  const config = createNodeConfig({ directory, port: await freePort() });
  const controller = new AbortController();
  const serving = serveDaemon(config, controller.signal);
  cleanup.push(async () => {
    controller.abort();
    await serving;
  });
  let state: { token: string } | undefined;
  for (let attempt = 0; !state && attempt < 100; attempt++) {
    state = await readFile(join(directory, "daemon.json"), "utf8")
      .then((text) => JSON.parse(text))
      .catch(() => undefined);
    if (!state) await delay(20);
  }
  if (!state) throw new Error("Daemon did not start");
  const client = createNodeClient(config);
  cleanup.push(async () => client.disconnect());
  return { config, client, received, gate, directory, token: state.token };
}

async function freePort() {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  if (!address || typeof address === "string") throw new Error("Missing address");
  return address.port;
}

/** Opens a raw local RPC socket and returns a function that waits for the next message. */
async function rawRpc(port: number, token: string) {
  const socket = new WebSocket(`ws://127.0.0.1:${port}/rpc`, {
    headers: { authorization: `Bearer ${token}` },
  });
  cleanup.push(async () => socket.terminate());
  const queue: { data: Buffer; binary: boolean }[] = [];
  const waiting: ((value: { data: Buffer; binary: boolean }) => void)[] = [];
  socket.on("message", (data, binary) => {
    const item = { data: data as Buffer, binary };
    const wake = waiting.shift();
    if (wake) wake(item);
    else queue.push(item);
  });
  await new Promise((resolve) => socket.once("open", resolve));
  const next = () =>
    new Promise<{ data: Buffer; binary: boolean }>((resolve) => {
      const item = queue.shift();
      if (item) resolve(item);
      else waiting.push(resolve);
    });
  const call = async (message: unknown) => {
    socket.send(JSON.stringify(message));
    return JSON.parse((await next()).data.toString());
  };
  return { socket, next, call };
}

describe("caller daemon binary requests", () => {
  it("relays input and output bytes as binary messages on both hops", async () => {
    const f = await fixture();
    const input = Buffer.from(Array.from({ length: 4096 }, (_, n) => n % 256));
    const result = await f.client.runBinary(target, "exec", { command: "cat" }, input);
    expect(result.response).toEqual({
      type: "response",
      ok: true,
      result: { request: { type: "request", action: "exec", args: { command: "cat" } } },
    });
    expect(Buffer.from(result.body).equals(Buffer.from(input).reverse())).toBe(true);
    expect(f.received).toHaveLength(1);
    expect(f.received[0].binary).toBe(true);
    const frame = parseFrame(f.received[0].data)!;
    expect(frame.peer).toBe(target);
    expect(Buffer.from(frame.body).equals(input)).toBe(true);
  });

  it("carries a 20 MiB body and maps route errors without a body", async () => {
    const f = await fixture();
    const input = Buffer.alloc(20 * 1024 * 1024, 0xff);
    input[0] = 0;
    const large = await f.client.runBinary(target, "exec", {}, input);
    expect(large.response.ok).toBe(true);
    expect(large.body.byteLength).toBe(input.byteLength);
    expect(large.body[large.body.byteLength - 1]).toBe(0);
    const missing = await f.client.runBinary(offline, "exec", {}, input.subarray(0, 10));
    expect(missing.response).toMatchObject({ ok: false, error: { code: "target_unavailable" } });
    expect(missing.body.byteLength).toBe(0);
    expect(await f.client.runBinary("target", "exec", {})).toMatchObject({
      response: { ok: false, error: { code: "invalid_request" } },
    });
  });

  it("negotiates protocol 3, rejects older clients, and keeps other methods text-only", async () => {
    const f = await fixture();
    const raw = await rawRpc(f.config.port, f.token);
    expect(
      await raw.call({
        jsonrpc: "2.0",
        id: 1,
        method: "daemon.hello",
        params: { protocolVersion: 2 },
      }),
    ).toMatchObject({ id: 1, error: { code: -32002 } });
    expect(
      await raw.call({
        jsonrpc: "2.0",
        id: 2,
        method: "daemon.hello",
        params: { protocolVersion: DAEMON_PROTOCOL_VERSION },
      }),
    ).toMatchObject({ id: 2, result: { protocolVersion: 3 } });
    expect(
      await raw.call({
        jsonrpc: "2.0",
        id: 3,
        method: "devices.runBinary",
        params: { deviceId: target, action: "exec" },
      }),
    ).toMatchObject({ id: 3, error: { code: -32600 } });
    raw.socket.send(
      encodeBinaryMessage(
        { jsonrpc: "2.0", id: 4, method: "daemon.status", params: {} },
        new Uint8Array(),
      ),
    );
    expect(JSON.parse((await raw.next()).data.toString())).toMatchObject({
      id: 4,
      error: { code: -32600 },
    });
    raw.socket.send(Buffer.from([0, 0, 0, 9, 1]));
    expect(JSON.parse((await raw.next()).data.toString())).toMatchObject({
      error: { code: -32600 },
    });
    raw.socket.send(
      encodeBinaryMessage(
        {
          jsonrpc: "2.0",
          id: 5,
          method: "devices.runBinary",
          params: { deviceId: target, action: "exec", args: {} },
        },
        Uint8Array.from([1, 2, 3]),
      ),
    );
    const reply = await raw.next();
    expect(reply.binary).toBe(true);
    const parsed = parseBinaryMessage(reply.data)!;
    expect(parsed.message).toMatchObject({ jsonrpc: "2.0", id: 5, result: { ok: true } });
    expect(Array.from(parsed.body)).toEqual([3, 2, 1]);
  });

  it("pushes and pulls files with progress, verified by SHA-256", async () => {
    const f = await fixture();
    const data = randomBytes(9 * 1024 * 1024 + 12_345);
    const local = join(f.directory, "local video.bin");
    const remote = join(f.directory, "remote.bin");
    await writeFile(local, data);
    await writeFile(remote, "old");
    const progress: { bytes: number; total: number }[] = [];
    const digest = createHash("sha256").update(data).digest("hex");
    const pushed = await f.client.copy(
      { direction: "push", localPath: local, deviceId: device.toUpperCase(), remotePath: remote },
      { onProgress: (event) => progress.push(event) },
    );
    expect(pushed).toMatchObject({ bytes: data.byteLength, sha256: digest });
    expect((await readFile(remote)).equals(data)).toBe(true);
    expect(progress.length).toBeGreaterThan(0);
    expect(progress.at(-1)).toEqual({ bytes: data.byteLength, total: data.byteLength });
    const pulled = await f.client.copy({
      direction: "pull",
      localPath: join(f.directory, "back.bin"),
      deviceId: device,
      remotePath: remote,
    });
    expect(pulled.sha256).toBe(digest);
    expect((await readFile(join(f.directory, "back.bin"))).equals(data)).toBe(true);
    expect((await readdir(f.directory)).some((name) => name.endsWith(".rome-part"))).toBe(false);
  });

  it("reports unsupported, unreachable, and invalid copies as action errors", async () => {
    const f = await fixture();
    const request = {
      direction: "pull" as const,
      localPath: join(f.directory, "x"),
      remotePath: "/x",
    };
    await expect(f.client.copy({ ...request, deviceId: older })).rejects.toMatchObject({
      code: "unsupported_device",
    });
    await expect(f.client.copy({ ...request, deviceId: offline })).rejects.toMatchObject({
      code: "target_unavailable",
    });
    await expect(
      f.client.copy({ ...request, deviceId: device, remotePath: join(f.directory, "missing") }),
    ).rejects.toMatchObject({ code: "not_found" });
    await expect(
      f.client.copy({ ...request, localPath: "relative/path", deviceId: device }),
    ).rejects.toMatchObject({ code: "invalid_request" });
    expect((await readdir(f.directory)).some((name) => name.startsWith("x"))).toBe(false);
  });

  it("aborts a running copy and removes the remote part file when the client disconnects", async () => {
    const f = await fixture();
    const local = join(f.directory, "large.bin");
    const remote = join(f.directory, "pushed.bin");
    await writeFile(local, randomBytes(40 * 1024 * 1024));
    // Forward the open reply and the first acknowledgement, then hold every later frame.
    f.gate.holdAfter = 2;
    let progressed = false;
    const copying = f.client
      .copy(
        { direction: "push", localPath: local, deviceId: device, remotePath: remote },
        {
          onProgress: () => {
            progressed = true;
          },
        },
      )
      .catch((error) => error);
    const deadline = Date.now() + 5000;
    while (!progressed && Date.now() < deadline) await delay(10);
    expect(progressed).toBe(true);
    expect(await readdir(f.directory)).toContain("pushed.bin.rome-part");
    f.client.disconnect();
    expect(await copying).toMatchObject({ code: "unknown_outcome" });
    const until = Date.now() + 5000;
    while ((await readdir(f.directory)).includes("pushed.bin.rome-part") && Date.now() < until)
      await delay(20);
    expect((await readdir(f.directory)).sort()).toEqual(
      ["caller.json", "daemon.json", "large.bin"].sort(),
    );
  });
});
