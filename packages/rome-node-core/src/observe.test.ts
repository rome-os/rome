import { afterEach, describe, expect, it } from "@rstest/core";
import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MAX_ROW_CHARS, ObserveStore, QueryError } from "./observe.js";
import type { ActionRow, LogQuery, LogResult } from "./observe-protocol.js";

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const clean of cleanup.splice(0).reverse()) await clean();
});

async function store(options: Partial<ConstructorParameters<typeof ObserveStore>[0]> = {}) {
  const directory = await mkdtemp(join(tmpdir(), "rome-node-observe-"));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "observe.db");
  const create = () => {
    const value = new ObserveStore({ path, ...options });
    value.open();
    cleanup.push(async () => value.close());
    return value;
  };
  return { directory, path, create, store: create() };
}

const device = "7c9e6679-7425-40de-944b-e07fc1f90ae7";
const exec = (command: string, args: string[], cwd?: string) => ({
  direction: "out" as const,
  peer: device,
  action: "exec",
  mode: "json" as const,
  command,
  args,
  cwd,
});
const actions = (value: unknown) => value as LogResult<ActionRow>;

describe("ObserveStore", () => {
  it("creates a private WAL database", async () => {
    const { path, store: log } = await store();
    log.startAction(exec("true", []));
    if (process.platform !== "win32") {
      expect((await stat(path)).mode & 0o777).toBe(0o600);
      expect((await stat(`${path}-wal`)).mode & 0o777).toBe(0o600);
    }
  });

  it("records an action from start to end", async () => {
    const { store: log } = await store();
    const started = log.startAction(exec("git", ["status"], "/workspace"));
    expect(started).toMatchObject({
      direction: "out",
      peer: device,
      command: "git",
      args: ["status"],
      cwd: "/workspace",
      endedAt: null,
      outcome: null,
    });
    expect(log.running().map((row) => row.id)).toEqual([started!.id]);
    const ended = log.endAction(started!.id, {
      outcome: "ok",
      exitCode: 1,
      stdoutBytes: 10,
      stderrBytes: 2,
    });
    expect(ended).toMatchObject({ outcome: "ok", exitCode: 1, stdoutBytes: 10, stderrBytes: 2 });
    expect(ended!.endedAt).not.toBeNull();
    expect(log.running()).toEqual([]);
  });

  it("marks actions a previous start left open as interrupted", async () => {
    const { store: log, create } = await store();
    const open = log.startAction(exec("sleep", ["100"]));
    log.close();
    const next = create();
    expect(actions(next.query({ kind: "actions" })).rows[0]).toMatchObject({
      id: open!.id,
      outcome: "interrupted",
    });
  });

  it("masks secrets with stars of the same length", async () => {
    const secret = `romedev_${"s".repeat(43)}`;
    const { store: log } = await store({ secrets: [secret] });
    const row = log.startAction(exec("curl", ["-H", `Authorization: Bearer ${secret}`]));
    expect(row!.args).toEqual(["-H", `Authorization: Bearer ${"*".repeat(secret.length)}`]);
  });

  it("pages newest first", async () => {
    const { store: log } = await store();
    const ids = Array.from({ length: 5 }, (_, index) => log.startAction(exec(`c${index}`, []))!.id);
    const first = actions(log.query({ kind: "actions", limit: 2 }));
    expect(first.rows.map((row) => row.id)).toEqual([ids[4], ids[3]]);
    expect(first.hasMore).toBe(true);
    const next = actions(log.query({ kind: "actions", before: ids[3], limit: 10 }));
    expect(next.rows.map((row) => row.id)).toEqual([ids[2], ids[1], ids[0]]);
    expect(next.hasMore).toBe(false);
    expect(() => log.query({ kind: "summary" } as never)).toThrow(QueryError);
  });

  it("filters by outcome, peer, and substring text", async () => {
    const { store: log } = await store();
    const a = log.startAction(exec("bash", ["-lc", "pnpm install --frozen-lockfile"], "/srv"))!;
    log.endAction(a.id, { outcome: "ok" });
    const b = log.startAction({ ...exec("ls", ["-la"]), peer: "other" })!;
    log.endAction(b.id, { outcome: "unknown_outcome", errorCode: "unknown_outcome" });
    expect(
      actions(log.query({ kind: "actions", text: "frozen" })).rows.map((row) => row.id),
    ).toEqual([a.id]);
    expect(actions(log.query({ kind: "actions", text: '"/sr' })).rows).toEqual([]);
    expect(
      actions(log.query({ kind: "actions", outcome: ["unknown_outcome"] })).rows.map(
        (row) => row.id,
      ),
    ).toEqual([b.id]);
    expect(actions(log.query({ kind: "actions", peer: device })).rows.map((row) => row.id)).toEqual(
      [a.id],
    );
    expect(() => log.query({ kind: "actions", text: "ab" })).toThrow(QueryError);
    expect(() => log.query({ kind: "actions", outcome: ["bad" as "ok"] })).toThrow(QueryError);
  });

  it("filters by result and start time", async () => {
    let now = 1_000_000;
    const { store: log } = await store({ now: () => now });
    const end = (end: Parameters<ObserveStore["endAction"]>[1]) => {
      const row = log.startAction(exec("true", []))!;
      log.endAction(row.id, end);
      return row.id;
    };
    const succeeded = end({ outcome: "ok", exitCode: 0 });
    const exited = end({ outcome: "ok", exitCode: 2 });
    const signaled = end({ outcome: "ok", signal: "SIGKILL" });
    const errored = end({ outcome: "error", errorCode: "target_unavailable" });
    const unknown = end({ outcome: "unknown_outcome" });
    const aborted = end({ outcome: "aborted" });
    now = 2_000_000;
    const running = log.startAction(exec("sleep", ["9"]))!.id;
    const ids = (query: Omit<LogQuery, "kind">) =>
      actions(log.query({ kind: "actions", ...query }))
        .rows.map((row) => row.id)
        .sort((a, b) => a - b);
    expect(ids({ result: ["succeeded"] })).toEqual([succeeded]);
    expect(ids({ result: ["failed"] })).toEqual([exited, signaled, errored]);
    expect(ids({ result: ["no_result"] })).toEqual([unknown, aborted]);
    expect(ids({ result: ["running", "succeeded"] })).toEqual([succeeded, running]);
    expect(ids({ since: 2_000_000 })).toEqual([running]);
    expect(ids({ until: 2_000_000 })).toHaveLength(6);
    expect(() => log.query({ kind: "actions", result: ["done" as "running"] })).toThrow(QueryError);
    expect(() => log.query({ kind: "actions", since: -1 })).toThrow(QueryError);
  });

  it("counts actions per peer, bucket, and result", async () => {
    let now = 60_000;
    const { store: log } = await store({ now: () => now });
    const at = (time: number, peer: string, end?: Parameters<ObserveStore["endAction"]>[1]) => {
      now = time;
      const row = log.startAction({ ...exec("true", []), peer })!;
      if (end) log.endAction(row.id, end);
    };
    at(59_000, device, { outcome: "ok" });
    at(60_000, device, { outcome: "ok" });
    at(61_000, device, { outcome: "ok" });
    at(62_000, device, { outcome: "ok", exitCode: 1 });
    at(75_000, device, { outcome: "unknown_outcome" });
    at(76_000, "other", { outcome: "ok" });
    at(79_000, device);
    now = 80_000;
    expect(log.stats({ since: 60_000, bucketMs: 10_000 })).toEqual({
      since: 60_000,
      until: 80_000,
      bucketMs: 10_000,
      groups: expect.arrayContaining([
        { peer: device, bucket: 0, result: "succeeded", count: 2 },
        { peer: device, bucket: 0, result: "failed", count: 1 },
        { peer: device, bucket: 1, result: "no_result", count: 1 },
        { peer: "other", bucket: 1, result: "succeeded", count: 1 },
        { peer: device, bucket: 1, result: "running", count: 1 },
      ]),
    });
    expect(log.stats({ since: 60_000, bucketMs: 10_000 }).groups).toHaveLength(5);
    expect(
      log.stats({ since: 60_000, until: 70_000, bucketMs: 10_000, peer: "other" }).groups,
    ).toEqual([]);
    expect(() => log.stats({ since: 0, bucketMs: 10 })).toThrow(QueryError);
    expect(() => log.stats({ since: 0, until: 80_000_000, bucketMs: 1000 })).toThrow(QueryError);
    expect(() => log.stats({ bucketMs: 10_000 } as never)).toThrow(QueryError);
  });

  it("cuts long text in results but stores it in full", async () => {
    const { store: log } = await store();
    const long = "x".repeat(MAX_ROW_CHARS + 10);
    const row = log.startAction(exec("echo", [long, "tail"]))!;
    expect(row.truncated).toBe(true);
    expect((row.args as string[]).join("").length).toBeLessThanOrEqual(MAX_ROW_CHARS);
    expect(actions(log.query({ kind: "actions", text: "tail" })).rows).toHaveLength(1);
  });

  it("deletes entries past retention", async () => {
    let now = 0;
    const { store: log } = await store({ now: () => now, retentionMs: 1000 });
    const old = log.startAction(exec("old", []))!;
    log.endAction(old.id, { outcome: "ok" });
    now = 5000;
    const fresh = log.startAction(exec("fresh", []))!;
    log.prune();
    expect(actions(log.query({ kind: "actions" })).rows.map((row) => row.id)).toEqual([fresh.id]);
  });

  it("drops the oldest entries when the file exceeds its budget", async () => {
    const { store: log } = await store({ maxBytes: 256 * 1024 });
    for (let index = 0; index < 200; index++) {
      const row = log.startAction(exec("echo", ["y".repeat(4096), String(index)]))!;
      log.endAction(row.id, { outcome: "ok" });
    }
    log.prune();
    const left = actions(log.query({ kind: "actions", limit: 500 })).rows;
    expect(left.length).toBeGreaterThan(0);
    expect(left.length).toBeLessThan(200);
    expect(left[0]!.args).toContain("199");
  });

  async function emptyDirectory() {
    const directory = await mkdtemp(join(tmpdir(), "rome-node-observe-"));
    cleanup.push(() => rm(directory, { recursive: true, force: true }));
    return { directory, path: join(directory, "observe.db") };
  }
  function opened(path: string) {
    const log = new ObserveStore({ path, now: () => Date.now() + Math.random() });
    log.open();
    cleanup.push(async () => log.close());
    return log;
  }
  const corruptCopies = async (directory: string) =>
    (await readdir(directory)).filter((name) => name.startsWith("observe.db.corrupt-"));

  it("sets a corrupt file aside, keeps only the newest copy, and starts a new one", async () => {
    const { directory, path } = await emptyDirectory();
    for (let round = 0; round < 3; round++) {
      await writeFile(path, "not a database".repeat(1000));
      const log = opened(path);
      expect(log.startAction(exec("true", []))).not.toBeNull();
      log.close();
    }
    expect(await corruptCopies(directory)).toHaveLength(1);
  });

  it("replaces a file from another schema version without keeping a copy", async () => {
    const { directory, path } = await emptyDirectory();
    const other = new DatabaseSync(path);
    other.exec("CREATE TABLE future (x); PRAGMA user_version = 99;");
    other.close();
    const log = opened(path);
    expect(log.startAction(exec("true", []))).not.toBeNull();
    expect(await corruptCopies(directory)).toEqual([]);
  });

  it("leaves a file it cannot open untouched and records nothing", async () => {
    const { directory, path } = await emptyDirectory();
    await mkdir(path);
    const log = opened(path);
    expect(log.startAction(exec("true", []))).toBeNull();
    expect(log.query({ kind: "actions" })).toEqual({ rows: [], hasMore: false });
    expect((await stat(path)).isDirectory()).toBe(true);
    expect(await corruptCopies(directory)).toEqual([]);
  });

  it("never throws when the WAL of a corrupt file cannot be removed", async () => {
    const { path } = await emptyDirectory();
    await writeFile(path, "not a database".repeat(1000));
    await mkdir(`${path}-wal`);
    await writeFile(join(`${path}-wal`, "keep"), "x");
    const log = new ObserveStore({ path });
    expect(() => log.open()).not.toThrow();
    cleanup.push(async () => log.close());
    expect(log.startAction(exec("true", []))).toBeNull();
  });
});
