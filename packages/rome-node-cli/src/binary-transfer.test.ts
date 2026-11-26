import { afterEach, describe, expect, it } from "@rstest/core";
import { spawn } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import { access, chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { WebSocketServer, type WebSocket } from "ws";
import { FRAME_TYPE, encodeFrame, encodeMeta, parseFrame, uuidBytes } from "@rome-os/node-core";
import { createNodeConfig, stopDaemon } from "@rome-os/node-core/client";
import { writePrivateJson } from "@rome-os/node-core/storage";

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const clean of cleanup.splice(0).reverse()) await clean();
});

/**
 * Reserves a daemon port below the OS ephemeral ranges (Linux 32768+, macOS and Windows 49152+).
 * A `listen(0)` port comes from that range, so after it is released any outbound connection or
 * other test can take it before the daemon binds (EADDRINUSE). Ports here are only held by
 * explicit binds, and the check below skips any that are taken.
 */
async function freePort() {
  for (;;) {
    const port = 20000 + Math.floor(Math.random() * 12000);
    const server = createServer();
    const bound = await new Promise<boolean>((resolve) => {
      server.once("error", () => resolve(false));
      server.listen(port, "127.0.0.1", () => resolve(true));
    });
    if (!bound) continue;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    return port;
  }
}

async function listen(server: Server) {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanup.push(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing server address");
  return address.port;
}

async function until(check: () => boolean) {
  const deadline = Date.now() + 10_000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("Condition timed out");
    await delay(20);
  }
}

/**
 * Relays text envelopes and binary frames between a real caller daemon and two real
 * `rome-node connect` hosts, rewriting the frame peer to the sender as the Gateway does.
 */
async function fixture(computerUse = false) {
  const root = await mkdtemp(join(tmpdir(), "rome-node-transfer-"));
  const port = await freePort();
  cleanup.push(() =>
    rm(root, { recursive: true, force: true, maxRetries: 5 }).catch((error) => {
      // A stopped daemon can hold observe.db open a little longer, and Windows refuses to remove
      // an open file. A leftover temporary directory is harmless there.
      if (process.platform !== "win32") throw error;
    }),
  );
  const identities = new Map<string, string>();
  const tokenFor = (letter: string) => `romedev_${letter.repeat(43)}`;
  const callerId = randomUUID();
  const deviceA = randomUUID();
  const deviceB = randomUUID();
  identities.set(tokenFor("c"), callerId);
  identities.set(tokenFor("a"), deviceA);
  identities.set(tokenFor("b"), deviceB);
  const online = new Map<string, WebSocket>();
  let binaryFrames = 0;
  const gateway = createServer();
  const sockets = new WebSocketServer({ server: gateway });
  sockets.on("connection", (socket, request) => {
    const self = identities.get(request.headers.authorization?.replace("Bearer ", "") ?? "");
    if (!self) {
      socket.close(4001);
      return;
    }
    online.set(self, socket);
    socket.on("close", () => {
      if (online.get(self) === socket) online.delete(self);
    });
    socket.on("message", (data, binary) => {
      if (binary) {
        binaryFrames++;
        const bytes = data as Buffer;
        const frame = parseFrame(bytes);
        if (!frame) {
          socket.close(1008);
          return;
        }
        const target = online.get(frame.peer);
        if (!target) {
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
        bytes.set(uuidBytes(self), 20);
        target.send(bytes);
        return;
      }
      const envelope = JSON.parse(data.toString());
      const target = online.get(envelope.to);
      if (target)
        target.send(JSON.stringify({ id: envelope.id, from: self, payload: envelope.payload }));
      else
        socket.send(JSON.stringify({ id: envelope.id, type: "error", code: "target_unavailable" }));
    });
  });
  cleanup.push(async () => {
    for (const socket of sockets.clients) socket.terminate();
    await new Promise<void>((resolve) => sockets.close(() => resolve()));
  });
  const gatewayPort = await listen(gateway);
  const cloud = createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    if (!identities.has(req.headers.authorization?.replace("Bearer ", "") ?? ""))
      res.writeHead(401).end(JSON.stringify({ error: "invalid_device_session" }));
    else if (req.url === "/v1/gateway/config")
      res.end(JSON.stringify({ gatewayUrl: `ws://127.0.0.1:${gatewayPort}` }));
    else if (req.url === "/api/account/devices")
      res.end(JSON.stringify({ items: [{ id: deviceA }, { id: deviceB }] }));
    else res.writeHead(404).end("{}");
  });
  const cloudUrl = `http://127.0.0.1:${await listen(cloud)}`;

  const helper = computerUse ? await headlessHelper(root) : undefined;
  function spawnCli(
    args: string[],
    directory: string,
    cwd = root,
    input?: Buffer,
    preload?: string,
    env?: NodeJS.ProcessEnv,
  ) {
    const child = spawn(process.execPath, [resolve("bin/rome-node.js"), ...args], {
      cwd,
      env: {
        ...process.env,
        ROME_NODE_CONFIG_DIR: directory,
        ROME_NODE_DAEMON_PORT: String(port),
        ...(preload ? { NODE_OPTIONS: `--import=${preload}` } : {}),
        ...env,
      },
      stdio: "pipe",
      windowsHide: true,
    });
    const stdout: Buffer[] = [];
    let stderr = "";
    child.stdout.on("data", (data: Buffer) => stdout.push(data));
    child.stderr.on("data", (data) => {
      stderr += data;
    });
    child.stdin.end(input);
    const exited = new Promise<number | null>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", resolve);
    });
    return { child, exited, stdout: () => Buffer.concat(stdout), stderr: () => stderr };
  }

  const hosts: Record<string, string> = {};
  let firstHost: ReturnType<typeof spawnCli> | undefined;
  for (const [letter, deviceId] of [
    ["a", deviceA],
    ["b", deviceB],
  ]) {
    const directory = join(root, `host-${letter}`);
    await mkdir(join(directory, "files"), { recursive: true });
    await writePrivateJson(join(directory, "credential.json"), {
      cloudUrl,
      token: tokenFor(letter),
      deviceId,
      name: `Host ${letter}`,
    });
    const testHelper = letter === "a" ? helper : undefined;
    const host = spawnCli(
      ["connect", "--cloud", cloudUrl],
      directory,
      join(directory, "files"),
      undefined,
      testHelper?.preload,
      helper
        ? { ROME_NODE_COMPUTER_USE_HELPER: testHelper?.appPath ?? join(root, "missing.app") }
        : undefined,
    );
    if (letter === "a") firstHost = host;
    cleanup.push(async () => {
      if (host.child.exitCode === null) host.child.kill();
      await host.exited;
    });
    hosts[deviceId] = join(directory, "files");
  }
  await until(() => online.has(deviceA) && online.has(deviceB));

  const caller = join(root, "caller");
  await writePrivateJson(join(caller, "caller.json"), { cloudUrl, token: tokenFor("c") });
  cleanup.push(() => stopDaemon(createNodeConfig({ directory: caller, port })));
  const cli = async (args: string[], input?: Buffer, env?: NodeJS.ProcessEnv) => {
    const run = spawnCli(args, caller, root, input, undefined, env);
    const code = await run.exited;
    return { code, stdout: run.stdout(), stderr: run.stderr() };
  };
  const reconnect = async () => {
    const previous = online.get(deviceA);
    previous?.close(1012);
    await until(() => online.has(deviceA) && online.get(deviceA) !== previous);
  };
  const revoke = () => online.get(deviceA)?.close(4001);
  return {
    root,
    deviceA,
    deviceB,
    hosts,
    cli,
    caller,
    reconnect,
    revoke,
    firstHost: firstHost!,
    binaryFrames: () => binaryFrames,
  };
}

const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aB9sAAAAASUVORK5CYII=",
  "base64",
);

async function headlessHelper(root: string) {
  const appPath = join(root, "Rome Computer Use.app");
  const executable = join(appPath, "Contents", "MacOS", "RomeComputerUse");
  await mkdir(join(appPath, "Contents", "MacOS"), { recursive: true });
  await writeFile(executable, "");
  await chmod(executable, 0o700);
  const preload = join(root, "headless-helper.mjs");
  const bridgeModule = pathToFileURL(resolve("../rome-node-core/dist/computer-use/bridge.js")).href;
  await writeFile(
    preload,
    `
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { createServer } from "node:net";
import { join } from "node:path";
import { ComputerUseBridge } from ${JSON.stringify(bridgeModule)};
import { FrameDecoder, encodeFrame } from ${JSON.stringify(new URL("frames.js", bridgeModule).href)};
import { ComputerUseError, createProof, verifyProof } from ${JSON.stringify(new URL("protocol.js", bridgeModule).href)};
const discovery = new URL("discovery.js", ${JSON.stringify(bridgeModule)}).href;
registerHooks({ load(url, context, next) {
  if (url !== discovery) return next(url, context);
  return { format: "module", shortCircuit: true, source: \`
    import { canAutoInstallHelper, discoverHelper as discover } from \${JSON.stringify(discovery + "?headless")};
    export { canAutoInstallHelper };
    export function discoverHelper() {
      return discover({ platform: "darwin" });
    }
  \` };
}});
const launch = ComputerUseBridge.launch.bind(ComputerUseBridge);
ComputerUseBridge.launch = (options) => launch({
  ...options, verifyBundle() {},
  async launcher({ stateDir }) {
    writeFileSync(${JSON.stringify(join(root, "helper-state-path"))}, stateDir);
    const bootstrap = JSON.parse(readFileSync(join(stateDir, "bootstrap.json"), "utf8"));
    const instance = randomUUID();
    const binding = randomUUID();
    const png = Buffer.from(${JSON.stringify(png.toString("base64"))}, "base64");
    const window = { window: 9, title: "private-window-name", appName: "Fake", bundleName: "Fake", bundleId: "test.fake", bounds: [0, 0, 1, 1] };
    const tree = { ref: "ref", title: "private-ax-text", role: "AXWindow", actions: [], children: [] };
    let stopped = false;
    const server = createServer((socket) => {
      socket.on("close", () => server.close());
      const decoder = new FrameDecoder(({ id, method, params }) => () => {
        let result;
        let body;
        switch (method) {
          case "hello": {
            const context = { secret: Buffer.from(bootstrap.secret, "hex"), nonce: Buffer.from(params.nonce, "base64"), hostPid: bootstrap.hostPid };
            if (!verifyProof(params.proof, context, "host")) throw new ComputerUseError("authentication_failed");
            result = { instance, helperPid: process.pid, helperProof: createProof(context, "helper", process.pid, instance), locale: "en", auth: "session" };
            break;
          }
          case "windows": result = { windows: [window] }; break;
          case "bind": result = { binding, window }; break;
          case "observe": {
            result = { binding, tree, truncated: false, refTTLms: 15000 };
            if (params.screenshot) {
              result.screenshot = { mimeType: "image/png", width: 1, height: 1, bytes: png.length };
              body = png;
            }
            break;
          }
          case "act": result = { binding, dispatched: true }; break;
          case "cancel": stopped = true; result = { stop: "cancel_requested", reason: "session_stopped" }; break;
          case "status": result = { instance, ...(stopped ? { stop: "stop_confirmed", reason: "session_stopped" } : { stop: "running" }) }; break;
          default: throw new Error(method);
        }
        socket.write(encodeFrame({ v: 1, id, ok: true, result }, body));
      });
      socket.on("data", (data) => decoder.push(data));
    });
    const socketPath = join(stateDir, "helper.sock");
    server.listen(socketPath);
    await once(server, "listening");
    chmodSync(socketPath, 0o600);
  }
});
`,
  );
  return { appPath, preload: pathToFileURL(preload).href };
}

it.skipIf(process.platform === "win32")(
  "serves Computer Use by default and transfers PNG over Gateway frames without desktop access",
  async () => {
    const f = await fixture(true);
    const describe = await f.cli(["device", "describe", f.deviceA]);
    expect(describe.stderr).toBe("");
    expect(JSON.parse(describe.stdout.toString())).toMatchObject({
      ok: true,
      result: {
        capabilities: [
          {
            id: "computer_use",
            prefix: "computer",
            state: "needs_permission",
            personal: true,
            actions: expect.arrayContaining(["computer.observe"]),
          },
        ],
        usage: {
          "computer.observe": expect.stringContaining("requires a binary request frame"),
          "computer.act": expect.stringContaining("actionId"),
        },
        actions: expect.arrayContaining([
          "computer.windows",
          "computer.bind",
          "computer.unbind",
          "computer.observe",
          "computer.act",
          "computer.cancel",
        ]),
      },
    });
    const run = async (action: string, args: unknown = {}, flags: string[] = [], code = 0) => {
      const reply = await f.cli([
        "device",
        "run",
        f.deviceA,
        `computer.${action}`,
        "--args",
        JSON.stringify(args),
        ...flags,
      ]);
      expect(reply.code).toBe(code);
      return JSON.parse(reply.stdout.toString());
    };
    expect(await run("windows")).toMatchObject({ result: { windows: [{ window: 9 }] } });
    const {
      result: { binding },
    } = await run("bind", { window: 9 });
    const approved = await f.cli(["device", "describe", f.deviceA]);
    expect(JSON.parse(approved.stdout.toString())).toMatchObject({
      result: { capabilities: [{ id: "computer_use", state: "on" }] },
    });
    expect(await run("observe", { binding })).toMatchObject({
      result: { binding, tree: { title: "private-ax-text" } },
    });
    expect(
      await run("observe", { binding, screenshot: true }, ["--output", "window.png"]),
    ).toMatchObject({ result: { screenshot: { bytes: png.length, mimeType: "image/png" } } });
    expect(await readFile(join(f.root, "window.png"))).toEqual(png);
    const shared = { ROME_TURN_AUDIENCE: "shared" };
    const observe = (screenshot: boolean) => [
      "device",
      "run",
      f.deviceA,
      "computer.observe",
      "--args",
      JSON.stringify({ binding, screenshot }),
    ];
    for (const args of [observe(false), [...observe(true), "--output", "shared.png"]]) {
      const blocked = await f.cli(args, undefined, shared);
      expect(blocked.code).toBe(1);
      expect(JSON.parse(blocked.stdout.toString())).toMatchObject({
        error: { code: "personal_data_private_only" },
      });
    }
    await expect(access(join(f.root, "shared.png"))).rejects.toMatchObject({ code: "ENOENT" });
    const actionId = randomUUID();
    const act = { binding, actionId, action: "type_text", text: "private-input-text" };
    expect(await run("act", act)).toMatchObject({ result: { actionId, dispatched: true } });
    expect(await run("cancel")).toMatchObject({ result: { stop: "cancel_requested" } });
    expect(await run("cancel")).toMatchObject({ result: { stop: "stop_confirmed" } });
    expect(await run("act", act, [], 1)).toMatchObject({ error: { code: "session_stopped" } });
    const unavailable = await f.cli(["device", "run", f.deviceB, "computer.windows"]);
    expect(unavailable.code).toBe(1);
    expect(JSON.parse(unavailable.stdout.toString())).toMatchObject({
      error: {
        code:
          process.platform === "darwin"
            ? "computer_use_helper_missing"
            : "computer_use_unsupported_platform",
      },
    });
    const audit = new DatabaseSync(join(f.root, "host-a", "audit", "audit.db"), { readOnly: true });
    const activity = new DatabaseSync(join(f.caller, "observe.db"), { readOnly: true });
    try {
      const host = JSON.stringify(
        audit.prepare("SELECT record FROM events WHERE action LIKE 'computer.%'").all(),
      );
      const caller = JSON.stringify(
        activity.prepare("SELECT args FROM actions WHERE action LIKE 'computer.%'").all(),
      );
      for (const log of [host, caller]) {
        expect(log).toContain(actionId);
        for (const secret of [
          act.text,
          "private-window-name",
          "private-ax-text",
          png.toString("base64"),
        ])
          expect(log).not.toContain(secret);
      }
      expect(audit.prepare("SELECT COUNT(*) AS rows FROM content").get()).toEqual({ rows: 0 });
    } finally {
      audit.close();
      activity.close();
    }
    await f.reconnect();
    const rebound = await run("bind", { window: 9 });
    expect(rebound.result.binding).not.toBe(binding);
    const stateDir = await readFile(join(f.root, "helper-state-path"), "utf8");
    await expect(access(stateDir)).resolves.toBeUndefined();
    f.revoke();
    expect(await f.firstHost.exited).toBe(1);
    await expect(access(stateDir)).rejects.toMatchObject({ code: "ENOENT" });
  },
  30_000,
);

describe("binary transfers through Gateway frames", () => {
  it("pushes and pulls a multi-chunk file with fs streams and replaces existing files", async () => {
    const f = await fixture();
    const data = randomBytes(2 * 8 * 1024 * 1024 + 12_345);
    // Windows file names cannot contain double quotes.
    const name = process.platform === "win32" ? "src it's $HOME.bin" : `src it's "q" $HOME.bin`;
    await writeFile(join(f.root, name), data);
    const remoteDir = join(f.hosts[f.deviceA], "in dir");
    await mkdir(remoteDir);
    const remote = join(remoteDir, name);
    await writeFile(remote, "existing remote content");

    const push = await f.cli(["cp", name, `${f.deviceA.toUpperCase()}:${remoteDir}/`]);
    expect(push.stderr).toContain("(100%)");
    expect(push.code).toBe(0);
    const digest = createHash("sha256").update(data).digest("hex");
    expect(JSON.parse(push.stdout.toString())).toMatchObject({
      bytes: data.length,
      sha256: digest,
    });
    expect((await readFile(remote)).equals(data)).toBe(true);

    await writeFile(join(f.root, "back.bin"), "existing local content");
    const pull = await f.cli(["cp", `${f.deviceA}:in dir/${name}`, "back.bin"]);
    expect(pull.code).toBe(0);
    expect(JSON.parse(pull.stdout.toString())).toMatchObject({
      bytes: data.length,
      sha256: digest,
    });
    expect((await readFile(join(f.root, "back.bin"))).equals(data)).toBe(true);
    for (const dir of [f.root, remoteDir])
      expect((await readdir(dir)).some((file) => file.endsWith(".rome-part"))).toBe(false);
    expect(f.binaryFrames()).toBeGreaterThan(8);

    const missing = await f.cli(["cp", `${f.deviceA}:missing.bin`, "never.bin"]);
    expect(missing.code).toBe(1);
    expect(JSON.parse(missing.stdout.toString())).toMatchObject({
      ok: false,
      error: { code: "not_found" },
    });
    expect((await readdir(f.root)).some((file) => file.startsWith("never.bin"))).toBe(false);

    const between = await f.cli(["cp", `${f.deviceA}:${remote}`, `${f.deviceB}:copy.bin`]);
    expect(between.code).toBe(1);
    expect(between.stderr).toContain("two steps through this computer");
    expect(await readdir(f.hosts[f.deviceB])).toEqual([]);
  }, 60_000);

  it.skipIf(process.platform === "win32")(
    "runs exec with raw stdin and stdout through device run --input and --output",
    async () => {
      const f = await fixture();
      const data = Buffer.from(Array.from({ length: 70_000 }, (_, n) => (n * 7) % 256));
      await writeFile(join(f.root, "in.bin"), data);
      const cat = JSON.stringify({ command: "cat" });
      const toFile = await f.cli([
        "device",
        "run",
        f.deviceA,
        "exec",
        "--args",
        cat,
        "--input",
        "in.bin",
        "--output",
        "out.bin",
      ]);
      expect(toFile.code).toBe(0);
      expect(JSON.parse(toFile.stdout.toString())).toEqual({
        type: "response",
        ok: true,
        result: {
          exitCode: 0,
          signal: null,
          stderr: "",
          truncated: { stdout: false, stderr: false },
        },
      });
      expect((await readFile(join(f.root, "out.bin"))).equals(data)).toBe(true);

      const piped = await f.cli(
        ["device", "run", f.deviceA, "exec", "--args", cat, "--input", "-"],
        data,
      );
      expect(piped.code).toBe(0);
      expect(piped.stdout.equals(data)).toBe(true);
      expect(JSON.parse(piped.stderr)).toMatchObject({ ok: true, result: { exitCode: 0 } });

      const failing = await f.cli([
        "device",
        "run",
        f.deviceA,
        "exec",
        "--args",
        JSON.stringify({ command: "sh", args: ["-c", "cat >/dev/null; exit 4"] }),
        "--input",
        "in.bin",
        "--output",
        "out.bin",
      ]);
      expect(failing.code).toBe(1);
      expect(JSON.parse(failing.stdout.toString())).toMatchObject({
        ok: true,
        result: { exitCode: 4 },
      });

      const text = await f.cli(["device", "run", f.deviceA, "exec", "--args", cat]);
      expect(JSON.parse(text.stdout.toString())).toMatchObject({ result: { stdout: "" } });
    },
    60_000,
  );
});
