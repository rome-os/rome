import { afterEach, describe, expect, it } from "@rstest/core";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { generateKeyPairSync, sign } from "node:crypto";
import { EventEmitter, once } from "node:events";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer, type Socket } from "node:net";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ComputerUseBridge } from "./bridge.js";
import { encodeFrame, FrameDecoder } from "./frames.js";
import {
  controllerFingerprint,
  createProof,
  type JsonObject,
  type RequestParams,
  verifyProof,
} from "./protocol.js";

const instance = "A980C63A-8313-47D8-AC0F-9E26D01236E1";
const binding = "5B49A753-ABA1-476C-A4F0-CE6155BEF144";
const tree = { ref: "ref", role: "AXButton", actions: ["press"], children: [] };
const observation = { binding, tree, truncated: false, refTTLms: 15_000 };
const action = { binding, element: "ref", action: "press" } as const;
const tempRoot = process.platform === "darwin" ? "/private/tmp" : "/tmp";
const cleanups: (() => void)[] = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

type HandshakeMode =
  | "normal"
  | "wrong_secret"
  | "wrong_proof"
  | "wrong_instance"
  | "wrong_pid"
  | "wrong_fingerprint"
  | "denied"
  | "stall";
type LaunchOptions = Parameters<typeof ComputerUseBridge.launch>[0];

function testController() {
  const keys = generateKeyPairSync("ed25519");
  return {
    label: "Rome Node CLI",
    scope: "remote" as const,
    publicKey: keys.publicKey
      .export({ format: "der", type: "spki" })
      .subarray(-32)
      .toString("base64"),
    sign: (payload: Buffer) => sign(null, payload, keys.privateKey),
  };
}

function mockHelper(
  options: { handshake?: HandshakeMode; socketMode?: number; autoStatus?: boolean } = {},
) {
  const events = new EventEmitter();
  const stalled = new Set<unknown>();
  const received: JsonObject[] = [];
  let stopped = false;
  let client: Socket | undefined;
  let stateDir = "";
  let bootstrap: { secret: string; hostPid: number; hostExecutable: string };
  let permissions: number[];

  function reply(request: JsonObject, result: JsonObject, png?: Buffer) {
    stalled.delete(request.id);
    client?.write(encodeFrame({ v: 1, id: request.id, ok: true, result }, png));
  }

  const stopState = () => ({
    stop: stalled.size ? "cancel_requested" : "stop_confirmed",
    reason: "session_stopped",
  });

  const server = createServer((socket) => {
    client = socket;
    socket.on("error", () => {});
    const decoder = new FrameDecoder((request) => () => {
      received.push(request);
      switch (request.method) {
        case "hello": {
          if (options.handshake === "stall") break;
          const params = request.params as RequestParams["hello"];
          const context = {
            secret:
              options.handshake === "wrong_secret"
                ? Buffer.alloc(32)
                : Buffer.from(bootstrap.secret, "hex"),
            nonce: Buffer.from(params.nonce, "base64"),
            hostPid: bootstrap.hostPid,
          };
          if (!verifyProof(params.proof, context, "host")) {
            socket.write(
              encodeFrame({
                v: 1,
                id: request.id,
                ok: false,
                error: { code: "authentication_failed" },
              }),
            );
            break;
          }
          if (options.handshake === "denied") {
            socket.write(
              encodeFrame({ v: 1, id: request.id, ok: false, error: { code: "consent_denied" } }),
            );
            break;
          }
          const helperProof =
            options.handshake === "wrong_proof"
              ? Buffer.alloc(32).toString("base64")
              : createProof(context, "helper", process.pid, instance);
          reply(request, {
            helperProof,
            instance: options.handshake === "wrong_instance" ? binding : instance,
            helperPid: options.handshake === "wrong_pid" ? process.pid + 1 : process.pid,
            locale: "en",
            ...(params.controller
              ? {
                  status: "challenge_required",
                  challenge: Buffer.alloc(32, 1).toString("base64"),
                  fingerprint:
                    options.handshake === "wrong_fingerprint"
                      ? "0000-0000-0000-0000-0000-0000-0000-0000"
                      : controllerFingerprint(params.controller.publicKey),
                }
              : { auth: "session" }),
          });
          break;
        }
        case "status":
          if (options.autoStatus !== false)
            reply(request, { instance, ...(stopped ? stopState() : { stop: "running" }) });
          break;
        case "cancel":
        case "stop":
          stopped = true;
          reply(request, stopState());
          break;
        default:
          stalled.add(request.id);
      }
      events.emit(String(request.method), request);
    });
    socket.on("data", (data: Buffer) => decoder.push(data));
  });
  cleanups.push(() => {
    client?.destroy();
    server.close();
    if (stateDir && existsSync(stateDir)) rmSync(stateDir, { recursive: true, force: true });
  });

  async function start(launchOptions: Partial<LaunchOptions> = {}) {
    const bridge = await ComputerUseBridge.launch({
      launcher: async ({ stateDir: directory }) => {
        stateDir = directory;
        const bootstrapPath = join(directory, "bootstrap.json");
        bootstrap = JSON.parse(readFileSync(bootstrapPath, "utf8"));
        const info = lstatSync(bootstrapPath);
        permissions = [lstatSync(directory).mode & 0o7777, info.mode & 0o7777, info.nlink];
        unlinkSync(bootstrapPath);
        const socketPath = join(directory, "helper.sock");
        server.listen(socketPath);
        await once(server, "listening");
        chmodSync(socketPath, options.socketMode ?? 0o600);
      },
      ...launchOptions,
    });
    cleanups.push(() => bridge.close());
    return bridge;
  }

  return {
    start,
    received,
    reply,
    write: (bytes: Buffer) => client?.write(bytes),
    disconnect: () => client?.destroy(),
    next: async (method: string) => (await once(events, method))[0] as JsonObject,
    get stateDir() {
      return stateDir;
    },
    get bootstrap() {
      return bootstrap;
    },
    get permissions() {
      return permissions;
    },
  };
}

describe("Computer Use Unix socket bridge", () => {
  it("creates a private one-use bootstrap and closes idempotently", async () => {
    const helper = mockHelper();
    const bridge = await helper.start();
    expect(helper.permissions).toEqual([0o700, 0o600, 1]);
    expect(helper.bootstrap).toEqual({
      secret: expect.stringMatching(/^[a-f0-9]{64}$/),
      hostPid: process.pid,
      hostExecutable: realpathSync(process.execPath),
    });
    expect(helper.stateDir).toBe(realpathSync(helper.stateDir));
    expect(Buffer.byteLength(join(helper.stateDir, "helper.sock"))).toBeLessThanOrEqual(103);
    expect(bridge.instanceId).toBe(instance);
    expect(bridge.helperPid).toBe(process.pid);
    expect(bridge.closed).toBe(false);
    expect(await bridge.status()).toEqual({ instance, stop: "running" });
    expect(helper.received[1]).not.toHaveProperty("params");
    const next = helper.next("windows");
    const pending = expect(bridge.windows()).rejects.toMatchObject({ code: "connection_closed" });
    await next;
    const errors: unknown[] = [];
    bridge.onDisconnect((error) => errors.push(error));
    bridge.close();
    bridge.close();
    await pending;
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ code: "connection_closed" });
    expect(bridge.closed).toBe(true);
    await expect(bridge.status()).rejects.toMatchObject({ code: "connection_closed" });
    expect(existsSync(helper.stateDir)).toBe(false);
  });

  it.each([
    "wrong_secret",
    "wrong_proof",
    "wrong_instance",
    "wrong_pid",
  ] as const)("rejects a handshake with %s and removes its state", async (handshake) => {
    const helper = mockHelper({ handshake });
    await expect(helper.start()).rejects.toMatchObject({ code: "authentication_failed" });
    expect(helper.received.map(({ method }) => method)).toEqual(["hello"]);
    expect(existsSync(helper.stateDir)).toBe(false);
  });

  it("passes through consent denial and never signs an unauthenticated challenge", async () => {
    const denied = mockHelper({ handshake: "denied" });
    await expect(denied.start()).rejects.toMatchObject({
      code: "consent_denied",
      retryable: false,
    });
    expect(existsSync(denied.stateDir)).toBe(false);

    const controller = testController();
    for (const handshake of ["wrong_proof", "wrong_fingerprint"] as const) {
      const helper = mockHelper({ handshake });
      let signed = false;
      await expect(
        helper.start({
          controller: {
            ...controller,
            sign: (payload) => {
              signed = true;
              return controller.sign(payload);
            },
          },
        }),
      ).rejects.toMatchObject({
        code: handshake === "wrong_proof" ? "authentication_failed" : "auth_failed",
      });
      expect(signed).toBe(false);
      expect(helper.received.map(({ method }) => method)).toEqual(["hello"]);
    }
  });

  it("rejects a controller grant whose scope differs from the signed challenge", async () => {
    const helper = mockHelper();
    const controller = testController();
    const next = helper.next("authorize");
    const launch = expect(helper.start({ controller })).rejects.toMatchObject({
      code: "auth_failed",
    });
    const request = await next;
    helper.reply(request, {
      auth: "session",
      fingerprint: controllerFingerprint(controller.publicKey),
      enrolled: false,
      label: controller.label,
      scope: "local",
      locale: "en",
    });
    await launch;
    expect(existsSync(helper.stateDir)).toBe(false);
  });

  it("cleans up after the connection and handshake deadlines", async () => {
    let stateDir = "";
    await expect(
      ComputerUseBridge.launch({
        startupTimeoutMs: 150,
        launcher: (launch) => {
          stateDir = launch.stateDir;
        },
      }),
    ).rejects.toMatchObject({ code: "startup_timeout" });
    expect(stateDir).not.toBe("");
    expect(existsSync(stateDir)).toBe(false);

    const helper = mockHelper({ handshake: "stall" });
    await expect(helper.start({ consentTimeoutMs: 150 })).rejects.toMatchObject({
      code: "request_timeout",
    });
    expect(helper.received).toHaveLength(1);
    expect(existsSync(helper.stateDir)).toBe(false);
  });

  it("bounds an asynchronous launcher and aborts it when startup expires", async () => {
    let stateDir = "";
    let signal: AbortSignal | undefined;
    await expect(
      ComputerUseBridge.launch({
        startupTimeoutMs: 150,
        launcher: (launch) => {
          stateDir = launch.stateDir;
          signal = launch.signal;
          return new Promise(() => {});
        },
      }),
    ).rejects.toMatchObject({ code: "startup_timeout" });
    expect(signal?.aborted).toBe(true);
    expect(existsSync(stateDir)).toBe(false);
  });

  it("rejects an overlong canonical socket path before launch", async () => {
    const root = mkdtempSync(join(tempRoot, "rcu-path-"));
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));
    const stateRoot = join(root, "界".repeat(30));
    mkdirSync(stateRoot);
    let launched = false;
    await expect(
      ComputerUseBridge.launch({
        stateRoot,
        launcher: () => {
          launched = true;
        },
      }),
    ).rejects.toMatchObject({ code: "socket_path_limit" });
    expect(launched).toBe(false);
    expect(readdirSync(stateRoot)).toEqual([]);
  });

  it("rejects an incorrectly permissioned socket and a non-socket at the same path", async () => {
    const helper = mockHelper({ socketMode: 0o660 });
    await expect(helper.start()).rejects.toMatchObject({ code: "socket_unavailable" });
    expect(existsSync(helper.stateDir)).toBe(false);

    let stateDir = "";
    await expect(
      ComputerUseBridge.launch({
        launcher: (launch) => {
          stateDir = launch.stateDir;
          writeFileSync(join(stateDir, "helper.sock"), "", { mode: 0o600 });
        },
      }),
    ).rejects.toMatchObject({ code: "socket_unavailable" });
    expect(existsSync(stateDir)).toBe(false);
  });

  it.each([
    "observe",
    "act",
  ] as const)("multiplexes cancel and status around a stalled %s reply", async (method) => {
    const helper = mockHelper();
    const bridge = await helper.start();
    const next = helper.next(method);
    const operation = method === "observe" ? bridge.observe(binding) : bridge.act(action);
    const request = await next;
    const [cancel, status] = await Promise.all([bridge.cancel(), bridge.status()]);
    expect(cancel).toEqual({ stop: "cancel_requested", reason: "session_stopped" });
    expect(status).toEqual({ instance, ...cancel });
    const result = method === "observe" ? observation : { binding, dispatched: true };
    helper.reply(request, result);
    expect(await operation).toEqual(result);
    expect(await bridge.status()).toEqual({
      instance,
      stop: "stop_confirmed",
      reason: "session_stopped",
    });
    expect(helper.received.find(({ method }) => method === "cancel")).not.toHaveProperty("params");
  });

  it("correlates reverse-order replies for different methods and returns a raw screenshot", async () => {
    const helper = mockHelper();
    const bridge = await helper.start();
    const nextWindows = helper.next("windows");
    const nextBind = helper.next("bind");
    const windows = bridge.windows("Notes");
    const bind = bridge.bind(12);
    const [windowsRequest, bindRequest] = await Promise.all([nextWindows, nextBind]);
    expect(windowsRequest.params).toEqual({ application: "Notes" });
    const window = {
      window: 12,
      appName: "Notes",
      bundleName: "Notes",
      bundleId: "com.apple.Notes",
      title: "Notes",
      bounds: [-2, 0, 10, 10],
    };
    helper.reply(bindRequest, { binding, window });
    expect(await bind).toEqual({ binding, window });
    helper.reply(windowsRequest, { windows: [window] });
    expect(await windows).toEqual({ windows: [window] });

    const nextObserve = helper.next("observe");
    const observe = bridge.observe(binding, { element: tree.ref, screenshot: true });
    const observeRequest = await nextObserve;
    expect(observeRequest.params).toEqual({ binding, element: tree.ref, screenshot: true });
    const png = Buffer.alloc(33);
    Buffer.from("89504e470d0a1a0a0000000d49484452", "hex").copy(png);
    png.writeUInt32BE(1, 16);
    png.writeUInt32BE(1, 20);
    const screenshot = { mimeType: "image/png", width: 1, height: 1, bytes: png.length };
    helper.reply(observeRequest, { ...observation, screenshot }, png);
    expect(await observe).toEqual({ ...observation, screenshot: { ...screenshot, png } });

    const nextUnbind = helper.next("unbind");
    const unbind = bridge.unbind(binding);
    const request = await nextUnbind;
    expect(request.params).toEqual({ binding });
    helper.reply(request, { binding, released: true });
    expect(await unbind).toEqual({ binding, released: true });
    expect(await bridge.stop()).toEqual({ stop: "stop_confirmed", reason: "session_stopped" });
  });

  it("disconnects when a frozen helper exhausts the unanswered request slots", async () => {
    const helper = mockHelper({ autoStatus: false });
    const bridge = await helper.start();
    const expired = await Promise.all(
      Array.from({ length: 255 }, () =>
        bridge.status({ timeoutMs: 15 }).catch((error: unknown) => error),
      ),
    );
    expect(
      expired.every((error) => error instanceof Error && error.message === "request_timeout"),
    ).toBe(true);
    expect(bridge.closed).toBe(false);

    const terminal = {
      code: "connection_closed",
      retryable: false,
      cause: expect.objectContaining({ code: "request_timeout" }),
    };
    const pending = expect(bridge.status()).rejects.toMatchObject(terminal);
    const disconnected = new Promise((resolve) => bridge.onDisconnect(resolve));
    await expect(bridge.status()).rejects.toMatchObject(terminal);
    await pending;
    expect(await disconnected).toMatchObject(terminal);
    await expect(bridge.cancel()).rejects.toMatchObject(terminal);
    expect(bridge.closed).toBe(true);
    expect(existsSync(helper.stateDir)).toBe(false);
  });

  it("reports a socket disconnect even when the state path cannot be inspected", async () => {
    const stateRoot = mkdtempSync(join(tempRoot, "rcu-cleanup-"));
    const moved = `${stateRoot}-moved`;
    cleanups.push(() => {
      rmSync(stateRoot, { recursive: true, force: true });
      rmSync(moved, { recursive: true, force: true });
    });
    const helper = mockHelper({ autoStatus: false });
    const bridge = await helper.start({ stateRoot });
    const next = helper.next("status");
    const pending = expect(bridge.status()).rejects.toMatchObject({ code: "connection_closed" });
    await next;
    renameSync(stateRoot, moved);
    writeFileSync(stateRoot, "");
    expect(() => lstatSync(helper.stateDir, { throwIfNoEntry: false })).toThrow(/ENOTDIR/);
    const disconnected = new Promise((resolve) => bridge.onDisconnect(resolve));
    helper.disconnect();
    await pending;
    expect(await disconnected).toMatchObject({ code: "connection_closed" });
    expect(bridge.closed).toBe(true);
    expect(() => bridge.close()).not.toThrow();
  });

  it("discards late replies, never replays requests, and marks action timeouts as unknown", async () => {
    const helper = mockHelper();
    const bridge = await helper.start();
    const nextAct = helper.next("act");
    const act = bridge.act(action, { timeoutMs: 150 });
    const actRejected = expect(act).rejects.toMatchObject({
      code: "action_outcome_unknown",
      actionOutcomeUnknown: true,
      retryable: false,
      cause: expect.objectContaining({ code: "request_timeout" }),
    });
    const actRequest = await nextAct;
    await actRejected;
    helper.reply(actRequest, { binding, dispatched: true });

    const nextObserve = helper.next("observe");
    const observe = bridge.observe(binding, { timeoutMs: 150 });
    const observeRejected = expect(observe).rejects.toMatchObject({
      code: "request_timeout",
      retryable: true,
    });
    const observeRequest = await nextObserve;
    await observeRejected;
    helper.reply(observeRequest, observation);

    expect(await bridge.status()).toEqual({ instance, stop: "running" });
    expect(helper.received.map(({ method }) => method)).toEqual([
      "hello",
      "act",
      "observe",
      "status",
    ]);
  });

  it("aborts independently before or after writing without replaying the action", async () => {
    const helper = mockHelper();
    const bridge = await helper.start();
    await expect(bridge.act(action, { signal: AbortSignal.abort() })).rejects.toMatchObject({
      code: "request_aborted",
    });
    const controller = new AbortController();
    const next = helper.next("act");
    const act = bridge.act(action, { signal: controller.signal });
    const rejected = expect(act).rejects.toMatchObject({
      code: "action_outcome_unknown",
      cause: expect.objectContaining({ code: "request_aborted" }),
    });
    const request = await next;
    controller.abort();
    await rejected;
    helper.reply(request, { binding, dispatched: true });
    expect(await bridge.status()).toEqual({ instance, stop: "running" });
    expect(helper.received.filter(({ method }) => method === "act")).toHaveLength(1);
  });

  it("rejects every pending request on EOF and cleans up before notifying listeners", async () => {
    const helper = mockHelper();
    const bridge = await helper.start();
    const disconnected = new Promise<string>((resolve) =>
      bridge.onDisconnect((error) => {
        expect(existsSync(helper.stateDir)).toBe(false);
        resolve(error.code);
      }),
    );
    const nextObserve = helper.next("observe");
    const nextAct = helper.next("act");
    const observe = expect(bridge.observe(binding)).rejects.toMatchObject({
      code: "connection_closed",
    });
    const act = expect(bridge.act(action)).rejects.toMatchObject({
      code: "action_outcome_unknown",
    });
    await Promise.all([nextObserve, nextAct]);
    helper.disconnect();
    await Promise.all([observe, act]);
    expect(await disconnected).toBe("connection_closed");
    expect(bridge.closed).toBe(true);
    await expect(bridge.cancel()).rejects.toMatchObject({ code: "connection_closed" });
  });

  it("fails closed on a binary announcement for a status reply before reading its body", async () => {
    const helper = mockHelper({ autoStatus: false });
    const bridge = await helper.start();
    const next = helper.next("status");
    const status = expect(bridge.status()).rejects.toMatchObject({ code: "invalid_frame" });
    const request = await next;
    const json = Buffer.from(
      JSON.stringify({
        v: 1,
        id: request.id,
        ok: true,
        result: {
          instance,
          stop: "running",
          screenshot: { mimeType: "image/png", width: 1, height: 1, bytes: 33 },
        },
      }),
    );
    const header = Buffer.alloc(8);
    header.writeUInt32BE(json.length, 0);
    header.writeUInt32BE(33, 4);
    helper.write(Buffer.concat([header, json]));
    await status;
    expect(bridge.closed).toBe(true);
    expect(existsSync(helper.stateDir)).toBe(false);
  });
});

const canBuildNative =
  process.platform === "darwin" &&
  process.arch === "arm64" &&
  spawnSync("/usr/bin/xcrun", ["--find", "swiftc"], { stdio: "ignore" }).status === 0;

it.skipIf(!canBuildNative)(
  "authenticates the macOS helper with session consent and an Ed25519 controller",
  async () => {
    const root = mkdtempSync(join(tempRoot, "rcu-swift-"));
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));
    const appPath = join(root, "Rome Computer Use.app");
    const script = fileURLToPath(new URL("../../scripts/computer-use.swift", import.meta.url));
    execFileSync("/usr/bin/swift", [script, "build", "--self-test-build", "--app", appPath], {
      timeout: 90_000,
    });

    await expect(ComputerUseBridge.launch({ appPath })).rejects.toMatchObject({
      code: "invalid_helper_bundle",
    });

    for (const controller of [undefined, testController()]) {
      let stateDir = "";
      let helperExit: Promise<unknown[]> | undefined;
      const bridge = await ComputerUseBridge.launch({
        appPath,
        controller,
        locale: "ja-JP",
        verifyBundle: () => {},
        launcher: (launch) => {
          stateDir = launch.stateDir;
          const child = spawn(
            "/bin/sh",
            [
              "-c",
              '"$@" & server=$!; wait "$server"',
              "rome-native-test",
              join(appPath, "Contents/MacOS/RomeComputerUse"),
              "--self-test-server",
              stateDir,
              "allow",
            ],
            { stdio: ["ignore", "ignore", "pipe"] },
          );
          helperExit = once(child, "exit");
          child.stderr?.on("data", (data) => process.stderr.write(data));
        },
      });
      cleanups.push(() => bridge.close());
      expect(bridge.helperPid).toBeGreaterThan(0);
      expect(existsSync(join(stateDir, "bootstrap.json"))).toBe(false);
      expect(await bridge.status()).toEqual({ instance: bridge.instanceId, stop: "running" });
      await expect(bridge.windows()).rejects.toMatchObject({
        code: "desktop_disabled",
        retryable: false,
      });
      expect(await bridge.cancel()).toEqual({ stop: "stop_confirmed", reason: "session_stopped" });
      bridge.close();
      expect(existsSync(stateDir)).toBe(false);
      expect(await helperExit).toEqual([0, null]);
    }
  },
  120_000,
);
