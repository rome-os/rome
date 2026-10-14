import { afterEach, describe, expect, it } from "@rstest/core";
import { mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MAX_ROW_CHARS, ObserveStore, QueryError } from "./observe.js";
import type { ActionRow, ActionSummary, LogResult } from "./observe-protocol.js";

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

  it("pages newest first and fills gaps oldest first", async () => {
    const { store: log } = await store();
    const ids = Array.from({ length: 5 }, (_, index) => log.startAction(exec(`c${index}`, []))!.id);
    const first = actions(log.query({ kind: "actions", limit: 2 }));
    expect(first.rows.map((row) => row.id)).toEqual([ids[4], ids[3]]);
    expect(first.hasMore).toBe(true);
    const next = actions(log.query({ kind: "actions", before: ids[3], limit: 10 }));
    expect(next.rows.map((row) => row.id)).toEqual([ids[2], ids[1], ids[0]]);
    expect(next.hasMore).toBe(false);
    const gap = actions(log.query({ kind: "actions", after: ids[2] }));
    expect(gap.rows.map((row) => row.id)).toEqual([ids[3], ids[4]]);
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

  it("cuts long text in results but stores it in full", async () => {
    const { store: log } = await store();
    const long = "x".repeat(MAX_ROW_CHARS + 10);
    const row = log.startAction(exec("echo", [long, "tail"]))!;
    expect(row.truncated).toBe(true);
    expect((row.args as string[]).join("").length).toBeLessThanOrEqual(MAX_ROW_CHARS);
    expect(actions(log.query({ kind: "actions", text: "tail" })).rows).toHaveLength(1);
  });

  it("summarizes outcomes and directions", async () => {
    let now = 1000;
    const { store: log } = await store({ now: () => now });
    const done = log.startAction(exec("a", []))!;
    log.endAction(done.id, { outcome: "error", errorCode: "busy" });
    log.startAction(exec("b", []));
    now = 5000;
    expect(log.query({ kind: "summary", from: 0, to: 2000 }) as ActionSummary).toEqual({
      total: 2,
      running: 1,
      byOutcome: { error: 1 },
      byDirection: { out: 2 },
    });
  });

  it("deletes entries past retention", async () => {
    let now = 0;
    const { store: log } = await store({ now: () => now, retentionMs: 1000 });
    const old = log.startAction(exec("old", []))!;
    log.endAction(old.id, { outcome: "ok" });
    log.recordLifecycle("caller", "connection", "online");
    now = 5000;
    const fresh = log.startAction(exec("fresh", []))!;
    log.prune();
    expect(actions(log.query({ kind: "actions" })).rows.map((row) => row.id)).toEqual([fresh.id]);
    expect(actions(log.query({ kind: "actions" })).oldest).toBe(5000);
    expect((log.query({ kind: "lifecycle" }) as LogResult<unknown>).rows).toEqual([]);
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

  it("sets a corrupt file aside and starts a new one", async () => {
    const { directory, path, store: first } = await store();
    first.close();
    await rm(path, { force: true });
    await rm(`${path}-wal`, { force: true });
    await rm(`${path}-shm`, { force: true });
    await writeFile(path, "not a database".repeat(1000));
    const log = new ObserveStore({ path });
    log.open();
    cleanup.push(async () => log.close());
    expect(log.startAction(exec("true", []))).not.toBeNull();
    expect((await readdir(directory)).some((name) => name.startsWith("observe.db.corrupt-"))).toBe(
      true,
    );
  });
});
