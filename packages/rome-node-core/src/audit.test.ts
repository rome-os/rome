import { afterEach, describe, expect, it } from "@rstest/core";
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { chmod, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { AUDIT_OUTPUT_BYTES, AuditStore, type AuditOpenOptions } from "./audit.js";

const cleanups: (() => Promise<unknown> | void)[] = [];
afterEach(async () => {
  for (const clean of cleanups.splice(0).reverse()) await clean();
});

const isRoot = process.getuid?.() === 0;
const sha = (data: Uint8Array) => createHash("sha256").update(data).digest("hex");

async function folder() {
  const dir = await mkdtemp(join(tmpdir(), "rome-node-audit-"));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

async function store(options: Partial<AuditOpenOptions> = {}, dir?: string) {
  const path = options.path ?? join(dir ?? (await folder()), "audit", "audit.db");
  const audit = await AuditStore.open({
    entry: "cli",
    hint: "Run rome-node audit status.",
    ...options,
    path,
  });
  cleanups.push(() => audit.close());
  return audit;
}

/** A second connection, as a person with sqlite3 would use. */
function raw(path: string) {
  const db = new DatabaseSync(path);
  cleanups.push(() => db.close());
  return db;
}

async function request(audit: AuditStore, n: number) {
  const seq = await audit.start(
    "exec",
    { requestId: `r${n}`, args: { command: "echo", args: [`${n}`] } },
    {
      stdin: Buffer.from(`input ${n}`),
    },
  );
  if (seq === null) throw new Error("start failed");
  audit.end(seq, "exec", "ok", { exitCode: 0 }, { stdout: Buffer.from(`output ${n}\n`) });
  return seq;
}

describe("audit chain", () => {
  it("verifies appended records and finds a change to any single column, content, or row", async () => {
    const audit = await store();
    for (let n = 0; n < 4; n++) await request(audit, n);
    expect(await audit.verify()).toEqual({ ok: true, records: 9 });
    const db = raw(audit.path);
    const tamper = async (sql: string, seq: number) => {
      const before = db.prepare("SELECT * FROM events WHERE seq = ?").get(seq);
      const content = db.prepare("SELECT * FROM content WHERE seq = ?").all(seq);
      db.exec(sql);
      const result = await audit.verify();
      expect({ sql, result }).toMatchObject({ sql, result: { ok: false, seq } });
      // Restore the row exactly, then the chain must verify again.
      db.exec("DELETE FROM content WHERE seq = " + seq);
      for (const row of content)
        db.prepare("INSERT INTO content VALUES (?, ?, ?)").run(row.seq, row.name, row.data);
      db.prepare("DELETE FROM events WHERE seq = ?").run(seq);
      const row = before as Record<string, never>;
      db.prepare("INSERT INTO events VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
        row.seq,
        row.at,
        row.kind,
        row.action,
        row.start_seq,
        row.outcome,
        row.record,
        row.prev_hash,
        row.hash,
      );
      expect((await audit.verify()).ok).toBe(true);
    };
    await tamper("UPDATE events SET at = at + 1 WHERE seq = 3", 3);
    await tamper("UPDATE events SET kind = 'host' WHERE seq = 3", 3);
    await tamper("UPDATE events SET action = 'fs.list' WHERE seq = 4", 4);
    await tamper("UPDATE events SET start_seq = 1 WHERE seq = 3", 3);
    await tamper("UPDATE events SET outcome = 'error' WHERE seq = 3", 3);
    await tamper(`UPDATE events SET record = replace(record, 'echo', 'rm') WHERE seq = 4`, 4);
    await tamper(`UPDATE events SET prev_hash = '${"1".repeat(64)}' WHERE seq = 5`, 5);
    await tamper("UPDATE content SET data = X'00' WHERE seq = 3", 3);
    db.exec("DELETE FROM events WHERE seq = 6");
    expect(await audit.verify()).toMatchObject({ ok: false, seq: 6 });
  });
});

describe("opening the audit log", () => {
  it("creates a private folder and file, and refuses a newer schema without changing it", async () => {
    const dir = await folder();
    const first = await store({}, dir);
    expect(first.state).toEqual({ state: "ok" });
    if (process.platform !== "win32") {
      const { statSync } = await import("node:fs");
      expect(statSync(join(dir, "audit")).mode & 0o777).toBe(0o700);
      expect(statSync(first.path).mode & 0o777).toBe(0o600);
    }
    first.close();
    const db = new DatabaseSync(first.path);
    db.exec("PRAGMA user_version = 99");
    db.close();
    const bytes = sha(await readFile(first.path));
    const files = await readdir(join(dir, "audit"));
    const second = await store({ path: first.path });
    expect(await second.status()).toMatchObject({ state: "unavailable", code: "newer_schema" });
    expect(await second.start("exec", {})).toBeNull();
    second.close();
    expect(sha(await readFile(first.path))).toBe(bytes);
    expect(await readdir(join(dir, "audit"))).toEqual(files);
  });

  it("reports random bytes as unreadable and never renames, deletes, or replaces the file", async () => {
    const dir = await folder();
    const path = join(dir, "audit.db");
    const junk = randomBytes(65536);
    await writeFile(path, junk, { mode: 0o600 });
    const audit = await store({ path });
    expect(audit.state).toMatchObject({ state: "unavailable", code: "unreadable" });
    expect((audit.state as { message: string }).message).toContain(path);
    expect(await audit.start("exec", {})).toBeNull();
    audit.close();
    expect((await readFile(path)).equals(junk)).toBe(true);
    expect(await readdir(dir)).toEqual(["audit.db"]);
  });

  it.skipIf(isRoot || process.platform === "win32")(
    "detects a read-only file at open and recovers 5 seconds after the permission returns",
    async () => {
      const dir = await folder();
      const path = join(dir, "audit.db");
      (await store({ path })).close();
      for (const name of await readdir(dir)) await chmod(join(dir, name), 0o400);
      let now = Date.now();
      const audit = await store({ path, now: () => now });
      expect(audit.state).toMatchObject({ state: "unavailable", code: "io" });
      for (const name of await readdir(dir)) await chmod(join(dir, name), 0o600);
      expect(await audit.start("exec", {})).toBeNull();
      now += 5000;
      expect(await audit.status()).toEqual({ state: "ok" });
      expect(await audit.start("exec", {})).toBeTypeOf("number");
    },
  );

  it.skipIf(isRoot || process.platform === "win32")("reports a read-only folder", async () => {
    const dir = await folder();
    await chmod(dir, 0o500);
    cleanups.push(() => chmod(dir, 0o700));
    const audit = await store({ path: join(dir, "audit", "audit.db") });
    expect(audit.state).toMatchObject({ state: "unavailable", code: "io" });
  });

  it("opens readers without writing", async () => {
    const writer = await store();
    await request(writer, 1);
    const before = writer.summary().records;
    const reader = await store({ path: writer.path, readOnly: true });
    expect(reader.state).toEqual({ state: "ok" });
    expect(await reader.start("exec", {})).toBeNull();
    reader.close();
    expect(writer.summary().records).toBe(before);
    const missing = await store({ path: join(await folder(), "none.db"), readOnly: true });
    expect(missing.state).toMatchObject({ state: "unavailable", code: "io" });
  });
});

describe("failed writes", () => {
  it("keeps a failed end in memory, writes it before the next start, and refuses while it cannot", async () => {
    const audit = await store();
    const db = raw(audit.path);
    const seq = (await audit.start("exec", { requestId: "a" }))!;
    db.exec(
      "CREATE TRIGGER fail BEFORE INSERT ON events BEGIN SELECT RAISE(ABORT, 'injected'); END",
    );
    audit.end(seq, "exec", "ok", { exitCode: 0 });
    expect(audit.state).toMatchObject({ state: "unavailable", code: "io" });
    expect(await audit.start("exec", { requestId: "b" })).toBeNull();
    db.exec("DROP TRIGGER fail");
    const next = await audit.start("exec", { requestId: "c" });
    expect(audit.state).toEqual({ state: "ok" });
    const items = audit.list({ action: "exec" });
    expect(items.map((item) => [item.seq, item.record.requestId, item.end?.seq ?? null])).toEqual([
      [next, "c", null],
      [seq, "a", next! - 1],
    ]);
    expect(await audit.verify()).toMatchObject({ ok: true });
  });
});

describe("several host processes on one log", () => {
  const moduleUrl = new URL("../dist/audit.js", import.meta.url).href;
  const child = (path: string, script: string) =>
    spawn(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `import { AuditStore } from ${JSON.stringify(moduleUrl)};
const audit = await AuditStore.open({ path: ${JSON.stringify(path)}, entry: "cli", hint: "" });
${script}`,
      ],
      { stdio: ["ignore", "pipe", "inherit"] },
    );
  const exited = (proc: ReturnType<typeof spawn>) =>
    new Promise<number | null>((resolve) => proc.once("exit", (code) => resolve(code)));

  it("keeps seq contiguous and the chain valid with two writers, and never ends another's request", async () => {
    const dir = await folder();
    const path = join(dir, "audit.db");
    (await store({ path })).close();
    const writer = `await Promise.all(Array.from({ length: 8 }, async (_, i) => {
  for (let n = 0; n < 10; n++) {
    const seq = await audit.start("exec", { worker: process.pid, i, n });
    if (seq === null) process.exit(3);
    audit.end(seq, "exec", "ok", { exitCode: 0 });
    await new Promise((r) => setImmediate(r));
  }
}));
audit.close();`;
    const codes = await Promise.all([exited(child(path, writer)), exited(child(path, writer))]);
    expect(codes).toEqual([0, 0]);
    // A third host is killed while its request runs; the others leave that request alone.
    const victim = child(
      path,
      `const seq = await audit.start("exec", { victim: true }); console.log(seq); setInterval(() => {}, 1000);`,
    );
    const victimSeq = await new Promise<number>((resolve) =>
      victim.stdout!.once("data", (chunk) => resolve(Number(String(chunk)))),
    );
    victim.kill("SIGKILL");
    await exited(victim);
    expect(
      await exited(
        child(
          path,
          `const seq = await audit.start("exec", {}); audit.end(seq, "exec", "ok", {}); audit.close();`,
        ),
      ),
    ).toBe(0);
    const reader = await store({ path, readOnly: true });
    expect(await reader.verify()).toMatchObject({ ok: true });
    const killed = reader.get(victimSeq)!;
    expect(killed.record.victim).toBe(true);
    expect(killed.end).toBeNull();
    const ends = reader.list({ action: "exec", limit: 1000 });
    expect(ends.filter((item) => item.end === null).map((item) => item.seq)).toEqual([victimSeq]);
    expect(ends.length).toBe(162);
  });
});

describe("content", () => {
  it("keeps the first 32 MiB of output with the full size and checksum", async () => {
    const audit = await store();
    const seq = (await audit.start("exec", {}))!;
    const stdout = Buffer.alloc(AUDIT_OUTPUT_BYTES + 8 * 1024 * 1024, 7);
    audit.end(seq, "exec", "error", { errorCode: "output_too_large" }, { stdout });
    const end = audit.get(seq)!.end!;
    expect(end.record.content).toEqual({
      stdout: {
        size: stdout.byteLength,
        sha256: sha(stdout),
        storedBytes: AUDIT_OUTPUT_BYTES,
        storedSha256: sha(stdout.subarray(0, AUDIT_OUTPUT_BYTES)),
      },
    });
    expect(audit.content(end.seq, "stdout")!.byteLength).toBe(AUDIT_OUTPUT_BYTES);
    expect(await audit.verify()).toMatchObject({ ok: true });
  });

  it("masks the device token in the record and content, in the database and its WAL", async () => {
    const audit = await store();
    const token = `romedev_${"Z".repeat(43)}`;
    const seq = (await audit.start(
      "exec",
      { args: { command: "sh", args: ["-c", `echo ${token}`] } },
      { stdin: Buffer.from(`stdin ${token}`) },
      [token],
    ))!;
    audit.end(
      seq,
      "exec",
      "ok",
      {},
      { stdout: Buffer.from(`out ${token}`), stderr: Buffer.from(token) },
      [token],
    );
    audit.host({ event: "connection", token }, [token]);
    for (const file of await readdir(join(audit.path, ".."))) {
      const bytes = await readFile(join(audit.path, "..", file));
      expect({ file, found: bytes.includes(token) }).toEqual({ file, found: false });
    }
    expect(audit.content(seq, "stdin")!.toString()).toBe(`stdin ${"*".repeat(token.length)}`);
    expect(JSON.stringify(audit.get(seq))).toContain("[redacted]");
  });
});

describe("retention", () => {
  it("deletes records older than 30 days, writes a prune record, and keeps the chain valid", async () => {
    let now = Date.parse("2026-01-01T00:00:00Z");
    const audit = await store({ now: () => now });
    for (let n = 0; n < 3; n++) await request(audit, n);
    now += 31 * 24 * 60 * 60 * 1000;
    await request(audit, 3);
    audit.prune();
    const items = audit.list();
    expect(items[0]).toMatchObject({ kind: "prune", record: { reason: "age" } });
    expect(items.some((item) => item.record.requestId === "r0")).toBe(false);
    expect(items.some((item) => item.record.requestId === "r3")).toBe(true);
    expect(await audit.verify()).toMatchObject({ ok: true });
    // Everything ages out: the chain continues from the last deleted record.
    now += 31 * 24 * 60 * 60 * 1000;
    audit.prune();
    await request(audit, 4);
    expect(await audit.verify()).toMatchObject({ ok: true });
  });

  it("over the size limit deletes the oldest content first and keeps its records", async () => {
    const audit = await store({ maxBytes: 3 * 1024 * 1024 });
    const seqs: number[] = [];
    for (let n = 0; n < 4; n++) {
      const seq = (await audit.start("exec", { n }))!;
      audit.end(seq, "exec", "ok", {}, { stdout: randomBytes(1024 * 1024) });
      seqs.push(seq);
    }
    audit.prune();
    const prune = audit.list()[0];
    expect(prune).toMatchObject({ kind: "prune", record: { reason: "size", rowsThroughSeq: 0 } });
    const oldest = audit.get(seqs[0])!;
    expect(oldest.end).not.toBeNull();
    expect(audit.content(oldest.end!.seq, "stdout")).toBeNull();
    expect(audit.content(audit.get(seqs[3])!.end!.seq, "stdout")).not.toBeNull();
    expect(await audit.verify()).toMatchObject({ ok: true });
    // A content row removed by hand, outside a prune, is still found.
    raw(audit.path).exec(`DELETE FROM content WHERE seq = ${audit.get(seqs[3])!.end!.seq}`);
    expect(await audit.verify()).toMatchObject({ ok: false, seq: audit.get(seqs[3])!.end!.seq });
  });
});

describe("export", () => {
  it("writes a snapshot that verifies on its own", async () => {
    const audit = await store();
    for (let n = 0; n < 3; n++) await request(audit, n);
    const out = join(await folder(), "export.db");
    await audit.export(out);
    await expect(audit.export(out)).rejects.toThrow("already exists");
    const copy = await store({ path: out, readOnly: true });
    expect(await copy.verify()).toEqual({ ok: true, records: 7 });
  });
});

describe("viewer queries", () => {
  it("lists requests only, filters and counts them by result, and buckets the last day", async () => {
    let now = Date.parse("2026-11-03T10:00:00Z");
    const audit = await store({ now: () => now });
    const run = async (outcome: "ok" | "exit_nonzero" | "error" | "interrupted" | null) => {
      const seq = (await audit.start("exec", { args: { command: "true" } }))!;
      if (outcome) audit.end(seq, "exec", outcome, {});
      now += 60_000;
    };
    for (const outcome of ["ok", "ok", "exit_nonzero", "error", "interrupted", null] as const)
      await run(outcome);
    audit.host({ event: "connection", status: "online" });
    expect(audit.list({ requestsOnly: true }).map((item) => item.kind)).toEqual(
      Array(6).fill("start"),
    );
    expect(audit.list({ result: "failed" })).toHaveLength(2);
    expect(audit.list({ result: "no_result" })).toHaveLength(2);
    expect(audit.resultCounts()).toEqual({ all: 6, succeeded: 2, failed: 2, no_result: 2 });
    const since = Date.parse("2026-11-03T09:00:00Z");
    const stats = audit.stats(since, since + 2 * 3600_000, 600_000);
    expect(stats.groups.reduce((n, g) => n + g.count, 0)).toBe(6);
    expect(new Set(stats.groups.map((g) => g.bucket))).toEqual(new Set([6]));
  });
});
