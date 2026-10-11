import { afterEach, describe, expect, it } from "@rstest/core";
import { spawn } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { WebSocketServer, type WebSocket } from "ws";
import { FRAME_TYPE, encodeFrame, encodeMeta, parseFrame, uuidBytes } from "@rome-os/node-core";
import { createNodeConfig, stopDaemon } from "@rome-os/node-core/client";
import { writePrivateJson } from "@rome-os/node-core/storage";

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const clean of cleanup.splice(0).reverse()) await clean();
});

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
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "rome-node-transfer-"));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
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

  function spawnCli(args: string[], directory: string, cwd = root, input?: Buffer) {
    const child = spawn(process.execPath, [resolve("bin/rome-node.js"), ...args], {
      cwd,
      env: { ...process.env, ROME_NODE_CONFIG_DIR: directory },
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
    const host = spawnCli(["connect", "--cloud", cloudUrl], directory, join(directory, "files"));
    cleanup.push(async () => {
      if (host.child.exitCode === null) host.child.kill();
      await host.exited;
    });
    hosts[deviceId] = join(directory, "files");
  }
  await until(() => online.has(deviceA) && online.has(deviceB));

  const caller = join(root, "caller");
  await writePrivateJson(join(caller, "caller.json"), { cloudUrl, token: tokenFor("c") });
  cleanup.push(() => stopDaemon(createNodeConfig({ directory: caller })));
  const cli = async (args: string[], input?: Buffer) => {
    const run = spawnCli(args, caller, root, input);
    const code = await run.exited;
    return { code, stdout: run.stdout(), stderr: run.stderr() };
  };
  return { root, deviceA, deviceB, hosts, cli, binaryFrames: () => binaryFrames };
}

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
