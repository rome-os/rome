import { afterEach, describe, expect, it } from "@rstest/core";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { AuditStore } from "@rome-os/node-core/host";

const cleanups: (() => Promise<unknown> | void)[] = [];
afterEach(async () => {
  for (const clean of cleanups.splice(0).reverse()) await clean();
});

function run(args: string[], root: string, wait = true) {
  const child = spawn(process.execPath, [resolve("bin/rome-node.js"), ...args], {
    env: { ...process.env, ROME_NODE_CONFIG_DIR: root },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const out: Buffer[] = [];
  let err = "";
  child.stdout.on("data", (data: Buffer) => out.push(data));
  child.stderr.on("data", (data) => {
    err += data;
  });
  const done = new Promise<{ code: number | null; stdout: string; bytes: Buffer; stderr: string }>(
    (done) =>
      child.once("close", (code) =>
        done({
          code,
          stdout: Buffer.concat(out).toString(),
          bytes: Buffer.concat(out),
          stderr: err,
        }),
      ),
  );
  if (!wait) cleanups.push(() => void child.kill());
  return { child, done, output: () => Buffer.concat(out).toString() };
}
const cli = (args: string[], root: string) => run(args, root).done;

async function populated() {
  const root = await mkdtemp(join(tmpdir(), "rome-node-cli-audit-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const audit = await AuditStore.open({
    path: join(root, "audit", "audit.db"),
    entry: "cli",
    hint: "",
  });
  cleanups.push(() => audit.close());
  const seq = (await audit.start(
    "exec",
    { requestId: "req-1", from: "caller-1", args: { command: "sh", args: ["-c", "echo hi"] } },
    { stdin: Buffer.from("input bytes") },
  ))!;
  audit.end(
    seq,
    "exec",
    "exit_nonzero",
    { exitCode: 3, durationMs: 5 },
    {
      stdout: Buffer.from("hi\n"),
    },
  );
  const list = (await audit.start("fs.list", { requestId: "req-2", args: { path: "/tmp" } }))!;
  audit.end(list, "fs.list", "ok", { path: "/tmp", entries: [] });
  return { root, audit, seq, list };
}

describe("rome-node audit", () => {
  it("shows status, tail, records, content, and search results", async () => {
    const { root, seq } = await populated();
    const status = await cli(["audit", "status", "--json"], root);
    expect(status.code).toBe(0);
    expect(JSON.parse(status.stdout)).toMatchObject({
      status: { state: "ok" },
      requests: 2,
      retention: { maxAgeDays: 30 },
    });
    const tail = await cli(["audit", "tail", "-n", "2"], root);
    expect(tail.stdout.trim().split("\n")).toHaveLength(2);
    expect(tail.stdout).toContain(
      'sh -c "echo hi"\texit_nonzero exit=3 5ms from=caller-1 (unverified)',
    );
    const show = JSON.parse((await cli(["audit", "show", String(seq), "--json"], root)).stdout);
    expect(show).toMatchObject({
      seq,
      record: { requestId: "req-1" },
      end: { record: { exitCode: 3 } },
    });
    expect(
      (await cli(["audit", "show", String(seq), "--content", "stdin"], root)).bytes.toString(),
    ).toBe("input bytes");
    expect((await cli(["audit", "show", String(seq), "--content", "stdout"], root)).stdout).toBe(
      "hi\n",
    );
    const search = await cli(["audit", "search", "--action", "fs.list", "--json"], root);
    expect(
      search.stdout
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line).record.requestId),
    ).toEqual(["req-2"]);
    expect((await cli(["audit", "search", "--text", "req-1"], root)).stdout).toContain("echo hi");
    expect((await cli(["audit", "search", "--outcome", "no_end"], root)).stdout).toBe("");
  });

  it("follows records another process writes", async () => {
    const { root, audit } = await populated();
    const tail = run(["audit", "tail", "-f", "-n", "1"], root, false);
    const until = async (check: () => boolean) => {
      const deadline = Date.now() + 8000;
      while (!check() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
    };
    await until(() => tail.output().includes("fs.list"));
    const seq = (await audit.start("exec", { args: { command: "late-command" } }))!;
    await until(() => tail.output().includes("late-command\tno end record"));
    audit.end(seq, "exec", "ok", { exitCode: 0 });
    await until(() => tail.output().includes("late-command\tok"));
    expect(tail.output()).toContain("late-command\tok exit=0");
  });

  it("reports a missing log and rejects audit options on other commands", async () => {
    const root = await mkdtemp(join(tmpdir(), "rome-node-cli-audit-"));
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    const status = await cli(["audit", "status"], root);
    expect(status.code).toBe(1);
    expect(status.stdout).toContain("There is no audit log yet");
    const wrong = await cli(["device", "--db", "x"], root);
    expect([wrong.code, wrong.stderr]).toEqual([1, "--db is only supported by rome-node audit.\n"]);
    expect((await cli(["audit", "status", "-n", "3"], root)).stderr).toContain(
      "only supported by rome-node audit tail",
    );
    expect((await cli(["audit", "nope"], root)).stderr).toContain("Usage: rome-node audit");
  });
});
