import { afterEach, describe, expect, it } from "@rstest/core";
import { createHash } from "node:crypto";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createExecutor, redactBytes } from "./executor.js";
import { decodeMeta, encodeMeta, FRAME_TYPE, type Frame } from "./frame.js";
import type { OutboundEnvelope } from "./protocol.js";

const requestId = "0f8fad5b-d9cb-469f-a165-70867728950e";
const caller = "7c9e6679-7425-40de-944b-e07fc1f90ae7";

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const clean of cleanups.splice(0)) await clean();
});

async function execute(action: string, args: unknown = {}) {
  const replies: OutboundEnvelope[] = [];
  const executor = createExecutor("Test computer", (reply) => {
    replies.push(reply);
    return true;
  });
  cleanups.push(async () => executor.disconnect());
  await executor.receive({
    id: "request",
    from: "caller",
    payload: { type: "request", action, args },
  });
  return replies[0];
}

async function executeFrame(
  action: string,
  args: unknown,
  body: Uint8Array = new Uint8Array(),
  secrets: string[] = [],
) {
  const frames: Frame[] = [];
  const texts: OutboundEnvelope[] = [];
  const executor = createExecutor(
    "Test computer",
    (reply) => {
      texts.push(reply);
      return true;
    },
    secrets,
    (frame) => {
      frames.push(frame);
      return true;
    },
  );
  cleanups.push(async () => executor.disconnect());
  await executor.receiveFrame({
    type: FRAME_TYPE.request,
    id: requestId,
    peer: caller,
    meta: encodeMeta({ type: "request", action, args }),
    body,
  });
  expect(texts).toEqual([]);
  expect(frames).toHaveLength(1);
  expect(frames[0]).toMatchObject({ type: FRAME_TYPE.response, id: requestId, peer: caller });
  return { response: decodeMeta(frames[0].meta), body: Buffer.from(frames[0].body) };
}

const allBytes = Buffer.from(Array.from({ length: 256 * 64 }, (_, n) => n % 256));

describe("computer actions over binary frames", () => {
  it("writes the request body to stdin and returns stdout bytes unchanged", async () => {
    const { response, body } = await executeFrame(
      "exec",
      {
        command: process.execPath,
        args: [
          "-e",
          "const c=[];process.stdin.on('data',d=>c.push(d)).on('end',()=>{process.stdout.write(Buffer.concat(c));process.stderr.write('done 🙂')})",
        ],
      },
      allBytes,
    );
    expect(response).toEqual({
      type: "response",
      ok: true,
      result: {
        exitCode: 0,
        signal: null,
        stderr: "done 🙂",
        truncated: { stdout: false, stderr: false },
      },
    });
    expect(body.equals(allBytes)).toBe(true);
  });

  it("gives an empty body immediate EOF and tolerates a child that ignores stdin", async () => {
    const eof = await executeFrame("exec", {
      command: process.execPath,
      args: ["-e", "process.stdin.resume().on('end',()=>process.stdout.write('eof'))"],
    });
    expect(eof.body.toString()).toBe("eof");
    const ignored = await executeFrame(
      "exec",
      { command: process.execPath, args: ["-e", "process.exit(3)"] },
      Buffer.alloc(4 * 1024 * 1024, 7),
    );
    expect(ignored.response).toMatchObject({ ok: true, result: { exitCode: 3 } });
    expect(ignored.body.byteLength).toBe(0);
  });

  it("redacts secrets in stdout with same-length bytes and in stderr as text", async () => {
    const secret = `romedev_${"s".repeat(43)}`;
    const { response, body } = await executeFrame(
      "exec",
      {
        command: process.execPath,
        args: [
          "-e",
          "process.stdout.write(Buffer.from([0,255]));process.stdout.write(process.argv[1]+'|'+process.argv[1]);process.stderr.write(process.argv[1])",
          secret,
        ],
      },
      undefined,
      [secret],
    );
    expect(body.byteLength).toBe(2 + secret.length * 2 + 1);
    expect(Array.from(body.subarray(0, 2))).toEqual([0, 255]);
    expect(body.subarray(2).toString()).toBe(
      `${"*".repeat(secret.length)}|${"*".repeat(secret.length)}`,
    );
    expect(response).toMatchObject({ ok: true, result: { stderr: "[redacted]" } });
    expect(redactBytes(Buffer.from("aaa"), ["aa", ""]).toString()).toBe("**a");
  });

  it("reports system.info, unsupported actions, and invalid arguments with empty bodies", async () => {
    const info = await executeFrame("system.info", {});
    expect(info.response).toMatchObject({
      ok: true,
      result: {
        name: "Test computer",
        actions: ["system.info", "exec"],
        frameVersion: 1,
        transferVersion: 1,
      },
    });
    expect(info.body.byteLength).toBe(0);
    expect((await executeFrame("fs.read", {})).response).toMatchObject({
      ok: false,
      error: { code: "unsupported_action" },
    });
    expect((await executeFrame("exec", { command: "" })).response).toMatchObject({
      ok: false,
      error: { code: "invalid_args" },
    });
    expect(
      (await executeFrame("exec", { command: "rome-node-nonexistent-executable" })).response,
    ).toMatchObject({ ok: false, error: { code: "exec_failed" } });
  });

  it("ignores non-request frames and never replies on a replacement connection", async () => {
    const frames: Frame[] = [];
    const executor = createExecutor(
      "Test",
      () => true,
      [],
      (frame) => {
        frames.push(frame);
        return true;
      },
    );
    const request = (meta: unknown): Frame => ({
      type: FRAME_TYPE.request,
      id: requestId,
      peer: caller,
      meta: encodeMeta(meta),
      body: new Uint8Array(),
    });
    await executor.receiveFrame({
      ...request({ type: "response", ok: true, result: {} }),
      type: FRAME_TYPE.response,
    });
    await executor.receiveFrame({ ...request({}), type: FRAME_TYPE.routeError });
    await executor.receiveFrame({ ...request({}), meta: Uint8Array.from([0xff]) });
    expect(frames).toEqual([]);
    const pending = executor.receiveFrame(
      request({
        type: "request",
        action: "exec",
        args: { command: process.execPath, args: ["-e", "setInterval(()=>{},1000)"] },
      }),
    );
    executor.disconnect();
    await pending;
    expect(frames).toEqual([]);
  });
});

async function until(check: () => boolean) {
  const deadline = Date.now() + 5000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("Condition timed out");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe("file transfers over binary frames", () => {
  it("receives a pushed file, replies to the sender, and stops on disconnect", async () => {
    const dir = await mkdtemp(join(tmpdir(), "rome-node-executor-transfer-"));
    cleanups.push(() => rm(dir, { recursive: true, force: true }));
    const frames: Frame[] = [];
    const executor = createExecutor(
      "Test",
      () => true,
      [],
      (frame) => {
        frames.push(frame);
        return true;
      },
    );
    const frame = (meta: unknown, body: Uint8Array = new Uint8Array()): Frame => ({
      type: FRAME_TYPE.request,
      id: requestId,
      peer: caller,
      meta: encodeMeta(meta),
      body,
    });
    const data = Buffer.from([0, 255, 1, 2]);
    const digest = createHash("sha256").update(data).digest("hex");
    const target = join(dir, "pushed.bin");
    await executor.receiveFrame(
      frame({
        type: "request",
        action: "transfer.open",
        args: { direction: "push", path: target, size: 4 },
      }),
    );
    await until(() => frames.length === 1);
    expect(frames.map((f) => decodeMeta(f.meta))).toEqual([
      { type: "response", ok: true, result: {} },
    ]);
    expect(frames[0]).toMatchObject({ type: FRAME_TYPE.response, id: requestId, peer: caller });
    await executor.receiveFrame(frame({ type: "transfer", kind: "data", offset: 0 }, data));
    await executor.receiveFrame(frame({ type: "transfer", kind: "end", size: 4, sha256: digest }));
    await until(() => frames.length === 3);
    expect(frames.map((f) => decodeMeta(f.meta)).slice(1)).toEqual([
      { type: "transfer", kind: "ack", offset: 4 },
      { type: "transfer", kind: "done", size: 4, sha256: digest },
    ]);
    expect((await readFile(target)).equals(data)).toBe(true);

    frames.length = 0;
    const second = join(dir, "second.bin");
    await executor.receiveFrame(
      frame({
        type: "request",
        action: "transfer.open",
        args: { direction: "push", path: second, size: 4 },
      }),
    );
    await until(() => frames.length === 1);
    executor.disconnect();
    await executor.receiveFrame(frame({ type: "transfer", kind: "data", offset: 0 }, data));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(frames).toHaveLength(1);
    expect(await readdir(dir)).toEqual(["pushed.bin"]);
  });

  it("does not offer transfers through text envelopes", async () => {
    expect(
      (await execute("transfer.open", { direction: "pull", path: "x" })).payload,
    ).toMatchObject({
      ok: false,
      error: { code: "unsupported_action" },
    });
  });
});

describe("computer actions", () => {
  it("reports actual platform and rejects unsupported actions", async () => {
    expect((await execute("system.info")).payload).toMatchObject({
      ok: true,
      result: { name: "Test computer", actions: ["system.info", "exec"] },
    });
    expect((await execute("fs.read")).payload).toMatchObject({
      ok: false,
      error: { code: "unsupported_action" },
    });
    expect((await execute("toString")).payload).toMatchObject({
      ok: false,
      error: { code: "unsupported_action" },
    });
  });
  it("preserves argument boundaries, Unicode paths, cwd, and actual file writes and reads", async () => {
    const dir = await mkdtemp(join(tmpdir(), "rome node 空格-"));
    cleanups.push(() => rm(dir, { recursive: true, force: true }));
    const args = ["space argument", "$(echo injected)", 'quote"value', "中文🙂", "a&b|c"];
    const reply = await execute("exec", {
      command: process.execPath,
      cwd: dir,
      args: [
        "-e",
        "require('fs').writeFileSync('test file.txt', JSON.stringify(process.argv.slice(1))); process.stdout.write(require('fs').readFileSync('test file.txt'))",
        ...args,
      ],
    });
    expect(reply).toMatchObject({
      to: "caller",
      id: "request",
      payload: {
        ok: true,
        result: {
          exitCode: 0,
          stdout: JSON.stringify(args),
          truncated: { stdout: false, stderr: false },
        },
      },
    });
    expect(JSON.parse(await readFile(join(dir, "test file.txt"), "utf8"))).toEqual(args);
  });
  it("reports nonzero program status and startup failures explicitly", async () => {
    expect(
      (
        await execute("exec", {
          command: process.execPath,
          args: ["-e", "process.stderr.write('failure');process.exit(7)"],
        })
      ).payload,
    ).toMatchObject({ ok: true, result: { exitCode: 7, stderr: "failure" } });
    expect(
      (await execute("exec", { command: "rome-node-nonexistent-executable" })).payload,
    ).toMatchObject({ ok: false, error: { code: "exec_failed" } });
    expect((await execute("exec", { command: "echo", args: [123] })).payload).toMatchObject({
      ok: false,
      error: { code: "invalid_args" },
    });
  });
  it("returns complete escaped and multibyte output above the former limits", async () => {
    const reply = await execute("exec", {
      command: process.execPath,
      args: [
        "-e",
        "process.stdout.write('\\u0000'.repeat(200000));process.stderr.write('🙂'.repeat(200000))",
      ],
    });
    expect(reply.payload).toMatchObject({
      ok: true,
      result: {
        stdout: "\u0000".repeat(200000),
        stderr: "🙂".repeat(200000),
        truncated: { stdout: false, stderr: false },
      },
    });
  });
  it("collects output above 32 MiB without truncating or replacing the result", async () => {
    const size = 33 * 1024 * 1024;
    const reply = await execute("exec", {
      command: process.execPath,
      args: ["-e", `process.stdout.write('x'.repeat(${size}))`],
    });
    const payload = reply.payload as {
      ok: boolean;
      result: { stdout: string; truncated: unknown };
    };
    expect(payload.ok).toBe(true);
    expect(payload.result.stdout.length).toBe(size);
    expect(payload.result.truncated).toEqual({ stdout: false, stderr: false });
  });
  it("terminates direct children and never sends their result after disconnect", async () => {
    const replies: OutboundEnvelope[] = [];
    const executor = createExecutor("Test", (reply) => {
      replies.push(reply);
      return true;
    });
    const pending = executor.receive({
      id: "slow",
      from: "caller",
      payload: {
        type: "request",
        action: "exec",
        args: {
          command: process.execPath,
          args: ["-e", "setInterval(()=>{},1000)"],
        },
      },
    });
    executor.disconnect();
    await pending;
    expect(replies).toEqual([]);
  });
});
