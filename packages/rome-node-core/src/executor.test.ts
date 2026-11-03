import { afterEach, describe, expect, it } from "@rstest/core";
import { createHash, randomBytes } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, parse } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { AuditStore } from "./audit.js";
import { createExecutor, FS_LIST_LIMIT, redactBytes } from "./executor.js";
import { decodeMeta, encodeMeta, FRAME_TYPE, MAX_FRAME_BYTES, type Frame } from "./frame.js";
import type { OutboundEnvelope } from "./protocol.js";

/** Records nothing. Tests of the audit log itself use a real AuditStore. */
const noAudit = {
  hint: "",
  start: async () => 1,
  end: () => {},
  host: () => {},
  status: async () => ({ state: "ok" as const }),
};

const requestId = "0f8fad5b-d9cb-469f-a165-70867728950e";
const caller = "7c9e6679-7425-40de-944b-e07fc1f90ae7";

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const clean of cleanups.splice(0)) await clean();
});

async function execute(action: string, args: unknown = {}) {
  const replies: OutboundEnvelope[] = [];
  const executor = createExecutor("Test computer", noAudit, (reply) => {
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
    noAudit,
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
        actions: ["system.info", "exec", "fs.list"],
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

  it("replaces stdout that cannot fit in one frame with output_too_large and keeps other programs", async () => {
    const frames: Frame[] = [];
    const executor = createExecutor(
      "Test",
      noAudit,
      () => true,
      [],
      (frame) => {
        frames.push(frame);
        return true;
      },
    );
    cleanups.push(async () => executor.disconnect());
    const request = (id: string, code: string): Frame => ({
      type: FRAME_TYPE.request,
      id,
      peer: caller,
      meta: encodeMeta({
        type: "request",
        action: "exec",
        args: { command: process.execPath, args: ["-e", code] },
      }),
      body: new Uint8Array(),
    });
    const slowId = "16fd2706-8baf-433b-82eb-8c7fada847da";
    const slow = executor.receiveFrame(
      request(slowId, "setTimeout(()=>process.stdout.write('still running'),500)"),
    );
    await executor.receiveFrame(
      request(requestId, `process.stdout.write(Buffer.alloc(${MAX_FRAME_BYTES + 1}))`),
    );
    expect(frames).toHaveLength(1);
    expect(decodeMeta(frames[0].meta)).toMatchObject({
      ok: false,
      error: { code: "output_too_large", message: expect.stringContaining("rome-node cp") },
    });
    expect(frames[0].body.byteLength).toBe(0);
    await slow;
    expect(frames[1]).toMatchObject({ id: slowId });
    expect(Buffer.from(frames[1].body).toString()).toBe("still running");
  });

  it("ignores non-request frames and never replies on a replacement connection", async () => {
    const frames: Frame[] = [];
    const executor = createExecutor(
      "Test",
      noAudit,
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
      noAudit,
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
    // Abort cleanup fsyncs and closes the part file before removing it, which can outlast 50 ms.
    const deadline = Date.now() + 5000;
    while ((await readdir(dir)).length > 1 && Date.now() < deadline)
      await new Promise((resolve) => setTimeout(resolve, 5));
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
      result: { name: "Test computer", actions: ["system.info", "exec", "fs.list"] },
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
    const executor = createExecutor("Test", noAudit, (reply) => {
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

describe("fs.list", () => {
  async function folder() {
    const dir = await realpath(await mkdtemp(join(tmpdir(), "rome node fs 空格-")));
    cleanups.push(() => rm(dir, { recursive: true, force: true }));
    return dir;
  }
  const list = async (args?: unknown) => (await execute("fs.list", args)).payload;

  it("lists the home folder when no path is given", async () => {
    const home = await realpath(homedir());
    expect(await list()).toMatchObject({ ok: true, result: { path: home } });
    expect(await list({})).toMatchObject({ ok: true, result: { path: home } });
  });

  it("returns typed entries, folders first, and the parent", async () => {
    const dir = await folder();
    await mkdir(join(dir, "b-folder"));
    await mkdir(join(dir, "z-folder"));
    await writeFile(join(dir, "a.txt"), "a");
    await symlink(join(dir, "z-folder"), join(dir, "link"));
    expect(await list({ path: dir })).toEqual({
      type: "response",
      ok: true,
      result: {
        path: dir,
        parent: join(dir, ".."),
        entries: [
          { name: "b-folder", type: "dir" },
          { name: "z-folder", type: "dir" },
          { name: "link", type: "symlink" },
          { name: "a.txt", type: "file" },
        ],
        truncated: false,
      },
    });
  });

  it("resolves a symlinked folder to its real path", async () => {
    const dir = await folder();
    await mkdir(join(dir, "target"));
    await symlink(join(dir, "target"), join(dir, "link"));
    expect(await list({ path: join(dir, "link") })).toMatchObject({
      ok: true,
      result: { path: join(dir, "target"), parent: dir, entries: [] },
    });
  });

  it("reports a missing path and a path that is not a folder", async () => {
    const dir = await folder();
    await writeFile(join(dir, "file"), "x");
    expect(await list({ path: join(dir, "missing") })).toMatchObject({
      ok: false,
      error: { code: "not_found" },
    });
    expect(await list({ path: join(dir, "file") })).toMatchObject({
      ok: false,
      error: { code: "not_a_directory" },
    });
  });

  it("has no parent at the filesystem root", async () => {
    const root = parse(tmpdir()).root;
    expect(await list({ path: root })).toMatchObject({
      ok: true,
      result: { path: root, parent: null },
    });
  });

  it("caps the entries and keeps folders inside the cap", async () => {
    const dir = await folder();
    await Promise.all(
      Array.from({ length: FS_LIST_LIMIT + 1 }, (_, n) => writeFile(join(dir, `f${n}`), "")),
    );
    await mkdir(join(dir, "zz-folder"));
    const reply = await list({ path: dir });
    expect(reply).toMatchObject({ ok: true, result: { truncated: true } });
    const entries = (reply as { result: { entries: { name: string }[] } }).result.entries;
    expect(entries).toHaveLength(FS_LIST_LIMIT);
    expect(entries[0]).toEqual({ name: "zz-folder", type: "dir" });
  });

  it("rejects invalid arguments in text and binary mode", async () => {
    for (const args of [{ path: "" }, { path: 1 }, { path: "a\0b" }, "path"])
      expect(await list(args)).toMatchObject({ ok: false, error: { code: "invalid_args" } });
    const dir = await folder();
    const { response, body } = await executeFrame("fs.list", { path: dir });
    expect(response).toMatchObject({ ok: true, result: { path: dir, entries: [] } });
    expect(body.byteLength).toBe(0);
  });
});

describe("audit log", () => {
  async function auditedExecutor(options: { failStarts?: boolean; secrets?: string[] } = {}) {
    const dir = await mkdtemp(join(tmpdir(), "rome-node-executor-audit-"));
    cleanups.push(() => rm(dir, { recursive: true, force: true }));
    const audit = await AuditStore.open({
      path: join(dir, "audit", "audit.db"),
      entry: "cli",
      hint: "Run rome-node audit status on that computer.",
    });
    cleanups.push(async () => audit.close());
    if (options.failStarts) {
      const db = new DatabaseSync(audit.path);
      db.exec(
        "CREATE TRIGGER fail BEFORE INSERT ON events WHEN NEW.kind = 'start' BEGIN SELECT RAISE(ABORT, 'disk full'); END",
      );
      db.close();
    }
    const replies: OutboundEnvelope[] = [];
    const frames: Frame[] = [];
    const executor = createExecutor(
      "Test",
      audit,
      (reply) => {
        replies.push(reply);
        return true;
      },
      options.secrets ?? [],
      (frame) => {
        frames.push(frame);
        return true;
      },
    );
    cleanups.push(async () => executor.disconnect());
    const json = (id: string, action: string, args: unknown = {}) =>
      executor.receive({ id, from: caller, payload: { type: "request", action, args } });
    const frame = (meta: unknown, body: Uint8Array = new Uint8Array(), id = requestId): Frame => ({
      type: FRAME_TYPE.request,
      id,
      peer: caller,
      meta: encodeMeta(meta),
      body,
    });
    const requests = () => audit.list({ limit: 1000 }).filter((item) => item.kind === "start");
    return { dir, audit, executor, replies, frames, json, frame, requests };
  }
  const node = (code: string) => ({ command: process.execPath, args: ["-e", code] });

  it("refuses to run anything it cannot record, and system.info says why", async () => {
    const { dir, json, replies, executor, frame, frames, requests } = await auditedExecutor({
      failStarts: true,
    });
    const marker = join(dir, "marker");
    await json("a", "exec", node(`require("fs").writeFileSync(${JSON.stringify(marker)}, "x")`));
    expect(replies[0].payload).toMatchObject({
      ok: false,
      error: {
        code: "audit_unavailable",
        message: expect.stringContaining("rome-node audit status"),
      },
    });
    await executor.receiveFrame(
      frame({
        type: "request",
        action: "transfer.open",
        args: { direction: "push", path: join(dir, "pushed"), size: 1 },
      }),
    );
    expect(decodeMeta(frames[0].meta)).toMatchObject({
      ok: false,
      error: { code: "audit_unavailable" },
    });
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect((await readdir(dir)).sort()).toEqual(["audit"]);
    await json("b", "system.info");
    expect(replies[1].payload).toMatchObject({
      ok: true,
      result: { audit: { state: "unavailable", code: "io" } },
    });
    expect(requests()).toEqual([]);
  });

  it("records exec before it runs and its result after, without environment values", async () => {
    const { json, replies, audit, requests } = await auditedExecutor();
    process.env.ROME_AUDIT_TEST_VALUE = "visible-value-not-recorded";
    cleanups.push(() => Promise.resolve(delete process.env.ROME_AUDIT_TEST_VALUE));
    await json("a", "exec", {
      ...node("console.log('hello'); console.error('oops'); process.exit(3)"),
      cwd: tmpdir(),
    });
    await json("b", "system.info");
    await json("c", "nosuch.action");
    await json("d", "exec", { command: "" });
    expect(replies.map((reply) => reply.payload)).toMatchObject([
      { ok: true, result: { exitCode: 3 } },
      { ok: true, result: { audit: { state: "ok" } } },
      { ok: false, error: { code: "unsupported_action" } },
      { ok: false, error: { code: "invalid_args" } },
    ]);
    const [invalid, unsupported, exec] = requests();
    expect(exec.record).toMatchObject({
      action: "exec",
      requestId: "a",
      from: caller,
      transport: "json",
      args: { command: process.execPath, cwd: tmpdir() },
    });
    expect(exec.record.envKeys).toContain("ROME_AUDIT_TEST_VALUE");
    expect(JSON.stringify(audit.list())).not.toContain("visible-value-not-recorded");
    expect(exec.end).toMatchObject({
      outcome: "exit_nonzero",
      record: { exitCode: 3, signal: null },
    });
    expect(exec.end!.record.pid).toBeTypeOf("number");
    expect(exec.end!.record.durationMs).toBeTypeOf("number");
    expect(audit.content(exec.end!.seq, "stdout")!.toString()).toBe("hello\n");
    expect(audit.content(exec.end!.seq, "stderr")!.toString()).toBe("oops\n");
    expect(unsupported.end).toMatchObject({
      outcome: "error",
      record: { errorCode: "unsupported_action" },
    });
    expect(invalid.end).toMatchObject({ outcome: "error", record: { errorCode: "invalid_args" } });
    expect(await audit.verify()).toMatchObject({ ok: true });
  });

  it("stores binary stdin and the first 32 MiB of output that did not fit in a frame", async () => {
    const { executor, frame, frames, audit, requests } = await auditedExecutor();
    const size = 40 * 1024 * 1024;
    await executor.receiveFrame(
      frame(
        {
          type: "request",
          action: "exec",
          args: node(`process.stdin.resume(); process.stdout.write(Buffer.alloc(${size}, 65))`),
        },
        Buffer.from("the input"),
      ),
    );
    expect(decodeMeta(frames[0].meta)).toMatchObject({
      ok: false,
      error: { code: "output_too_large" },
    });
    const [exec] = requests();
    expect(audit.content(exec.seq, "stdin")!.toString()).toBe("the input");
    expect(exec.end).toMatchObject({
      outcome: "error",
      record: {
        errorCode: "output_too_large",
        exitCode: 0,
        content: {
          stdout: {
            size,
            sha256: createHash("sha256").update(Buffer.alloc(size, 65)).digest("hex"),
            storedBytes: MAX_FRAME_BYTES,
          },
        },
      },
    });
  });

  it("marks a request cut off by a replaced connection as interrupted and sends nothing", async () => {
    const { json, replies, executor, requests } = await auditedExecutor();
    const pending = json("a", "exec", node("setInterval(() => {}, 1000)"));
    await until(() => requests().length === 1);
    await new Promise((resolve) => setTimeout(resolve, 100));
    executor.disconnect();
    await pending;
    expect(replies).toEqual([]);
    expect(requests()[0].end).toMatchObject({ outcome: "interrupted", record: { replyBytes: 0 } });
  });

  it("lets a stopping host wait until cut-off requests have written their end records", async () => {
    const { json, executor, requests } = await auditedExecutor();
    void json("a", "exec", node("setInterval(() => {}, 1000)"));
    await until(() => requests().length === 1);
    executor.disconnect();
    await executor.idle();
    expect(requests()[0].end).toMatchObject({ outcome: "interrupted" });
  });

  it("records pushes with content up to 10 MiB, the replaced file, and acknowledged pull bytes", async () => {
    const { dir, executor, frame, frames, audit, requests } = await auditedExecutor();
    const push = async (id: string, path: string, data: Buffer) => {
      frames.length = 0;
      const digest = createHash("sha256").update(data).digest("hex");
      await executor.receiveFrame(
        frame(
          {
            type: "request",
            action: "transfer.open",
            args: { direction: "push", path, size: data.byteLength },
          },
          undefined,
          id,
        ),
      );
      await until(() => frames.length === 1);
      await executor.receiveFrame(frame({ type: "transfer", kind: "data", offset: 0 }, data, id));
      await executor.receiveFrame(
        frame(
          { type: "transfer", kind: "end", size: data.byteLength, sha256: digest },
          undefined,
          id,
        ),
      );
      await until(() => requests().find((item) => item.record.requestId === id)?.end != null);
      return { digest, item: requests().find((item) => item.record.requestId === id)! };
    };
    const target = join(dir, "pushed.bin");
    await writeFile(target, "old");
    const small = randomBytes(5 * 1024 * 1024);
    const first = await push("0f8fad5b-d9cb-469f-a165-70867728950a", target, small);
    expect(first.item.end!.record).toMatchObject({
      direction: "push",
      path: target,
      bytes: small.byteLength,
      sha256: first.digest,
      replaced: { size: 3 },
      content: { file: { size: small.byteLength, sha256: first.digest } },
    });
    expect(audit.content(first.item.end!.seq, "file")!.equals(small)).toBe(true);
    const large = randomBytes(11 * 1024 * 1024);
    const second = await push(
      "0f8fad5b-d9cb-469f-a165-70867728950b",
      join(dir, "large.bin"),
      large,
    );
    expect(second.item.end!.record).toMatchObject({
      bytes: large.byteLength,
      sha256: second.digest,
      replaced: null,
    });
    expect(second.item.end!.record.content).toBeUndefined();

    frames.length = 0;
    const pullId = "0f8fad5b-d9cb-469f-a165-70867728950c";
    await executor.receiveFrame(
      frame(
        { type: "request", action: "transfer.open", args: { direction: "pull", path: target } },
        undefined,
        pullId,
      ),
    );
    await until(() => frames.length >= 2);
    await executor.receiveFrame(
      frame({ type: "transfer", kind: "ack", offset: 1024 }, undefined, pullId),
    );
    executor.disconnect();
    await until(() => requests().find((item) => item.record.requestId === pullId)?.end != null);
    expect(requests().find((item) => item.record.requestId === pullId)!.end).toMatchObject({
      outcome: "interrupted",
      record: { direction: "pull", ackedBytes: 1024, errorCode: "connection_lost" },
    });
    expect(await audit.verify()).toMatchObject({ ok: true });
  });
});
