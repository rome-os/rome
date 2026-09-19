import { afterEach, describe, expect, it } from "@rstest/core";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createExecutor } from "./executor.js";
import { MAX_MESSAGE_BYTES, type OutboundEnvelope } from "./protocol.js";

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
  it("bounds escaped and multibyte output including the envelope", async () => {
    const reply = await execute("exec", {
      command: process.execPath,
      args: [
        "-e",
        "process.stdout.write('\\u0000'.repeat(200000));process.stderr.write('🙂'.repeat(200000))",
      ],
    });
    expect(Buffer.byteLength(JSON.stringify(reply))).toBeLessThanOrEqual(MAX_MESSAGE_BYTES);
    expect(reply.payload).toMatchObject({
      ok: true,
      result: { truncated: { stdout: true, stderr: true } },
    });
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
