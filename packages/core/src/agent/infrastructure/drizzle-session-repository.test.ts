import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "@rstest/core";
import Database from "better-sqlite3";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "../../db/schema.js";
import type { DrizzleDb } from "../../db/index.js";
import { sessions, sessionTurnCheckpoints } from "../../db/schema.js";
import { createTestDb, type TestDb } from "../../test/db.js";
import { ActiveSessionExistsError } from "../domain/session-repository.js";
import { Session } from "../domain/session.js";
import { DrizzleSessionRepository } from "./drizzle-session-repository.js";

const seconds = (date: Date) => Math.floor(date.getTime() / 1000);
/** A snapshot as the database keeps it: timestamps to the second. */
const stored = (state: ReturnType<Session["snapshot"]>) => ({
  ...state,
  createdAt: seconds(state.createdAt),
  lastActiveAt: seconds(state.lastActiveAt),
});

describe("DrizzleSessionRepository", () => {
  let testDb: TestDb;
  let repo: DrizzleSessionRepository;

  beforeEach(() => {
    testDb = createTestDb();
    repo = new DrizzleSessionRepository(testDb.db);
  });

  afterEach(() => testDb.close());

  it("add() stores a session that session() reads back", async () => {
    const session = Session.create("main", {
      continuityKey: "telegram:thread-1",
      workingDir: "/w",
    });
    await repo.add(session);

    const found = await repo.session(session.id);
    expect(found).not.toBeNull();
    // Timestamps are stored to the second.
    expect(stored(found!.snapshot())).toEqual(stored(session.snapshot()));
    expect(await repo.session("nobody")).toBeNull();
  });

  it("add() refuses a second active session for the continuity key and agent", async () => {
    const first = Session.create("main", { continuityKey: "k" });
    await repo.add(first);

    await expect(repo.add(Session.create("main", { continuityKey: "k" }))).rejects.toBeInstanceOf(
      ActiveSessionExistsError,
    );
    // Another agent, another continuity key, or no continuity key is fine.
    await repo.add(Session.create("other", { continuityKey: "k" }));
    await repo.add(Session.create("main", { continuityKey: "k2" }));
    await repo.add(Session.create("main"));
    await repo.add(Session.create("main"));
  });

  it("add() writes a turn recorded before the add, checkpoint included", async () => {
    // A persisted fork records what it ran on before it is added.
    const session = Session.create("main", { deprecatedId: "fork-1" });
    session.recordTurn({
      provider: "openai",
      modelThreadId: "t-1",
      model: "gpt-5",
      checkpoint: { turnId: "turn-1", checkpointId: "c-1" },
    });
    await repo.add(session);

    const found = (await repo.session("fork-1"))!;
    expect(found.provider).toBe("openai");
    expect(found.modelThreadId).toBe("t-1");
    expect(found.model).toBe("gpt-5");
    expect((await repo.deprecatedCheckpoint("fork-1", "turn-1"))?.checkpointId).toBe("c-1");
    expect(session.pendingChanges().checkpoints).toEqual([]);
  });

  it("add() accepts a successor once the earlier session is completed", async () => {
    const first = Session.create("main", { continuityKey: "k" });
    await repo.add(first);
    first.complete();
    await repo.save(first);
    await repo.add(Session.create("main", { continuityKey: "k" }));
  });

  it("current() finds the active session for the continuity key and agent, idle or not", async () => {
    const session = Session.create("main", { continuityKey: "telegram:thread-1" });
    await repo.add(session);
    await testDb.db
      .update(sessions)
      .set({ lastActiveAt: new Date("2020-01-01T00:00:00Z") })
      .where(eq(sessions.id, session.id));

    expect((await repo.current("telegram:thread-1", "main"))?.id).toBe(session.id);
    expect(await repo.current("telegram:other", "main")).toBeNull();
    expect(await repo.current("telegram:thread-1", "other")).toBeNull();
  });

  it("current() ignores a completed session", async () => {
    const session = Session.create("main", { continuityKey: "k" });
    await repo.add(session);
    session.complete();
    await repo.save(session);
    expect(await repo.current("k", "main")).toBeNull();
  });

  it("current() finds a session only under its agent's name as written", async () => {
    const session = Session.create("code-review:reviewer", { continuityKey: "webchat:review" });
    await repo.add(session);

    expect((await repo.current("webchat:review", "code-review:reviewer"))?.id).toBe(session.id);
    expect(await repo.current("webchat:review", "reviewer")).toBeNull();
  });

  it("renames sessions saved under an agent's old name, and leaves the rest", async () => {
    const old = Session.create("reviewer", { continuityKey: "webchat:review" });
    const other = Session.create("main", { continuityKey: "webchat:other" });
    await repo.add(old);
    await repo.add(other);

    expect(repo.deprecatedRenameAgents({ reviewer: "code-review:reviewer" })).toBe(1);
    expect(repo.deprecatedRenameAgents({ reviewer: "code-review:reviewer" })).toBe(0);
    expect((await repo.current("webchat:review", "code-review:reviewer"))?.id).toBe(old.id);
    expect((await repo.session(other.id))?.agentName).toBe("main");
  });

  it("save() writes what a turn ran on, its checkpoint, and a move", async () => {
    const session = Session.create("main", { continuityKey: "k" });
    await repo.add(session);

    session.recordTurn({
      provider: "openai",
      modelThreadId: "t-1",
      model: "gpt-5",
      reasoningEffort: "xhigh",
      checkpoint: { turnId: "turn-1", checkpointId: "c-1" },
    });
    session.moveTo("/elsewhere");
    session.touch();
    await repo.save(session);

    const found = (await repo.session(session.id))!;
    expect(found.provider).toBe("openai");
    expect(found.modelThreadId).toBe("t-1");
    expect(found.model).toBe("gpt-5");
    expect(found.reasoningEffort).toBe("xhigh");
    expect(found.workingDir).toBe("/elsewhere");
    expect(await repo.deprecatedCheckpoint(session.id, "turn-1")).toEqual({
      sessionId: session.id,
      turnId: "turn-1",
      provider: "openai",
      modelThreadId: "t-1",
      checkpointId: "c-1",
    });
    expect(await repo.deprecatedCheckpoint(session.id, "turn-2")).toBeNull();
  });

  it("save() writes every turn's checkpoint recorded since the last save", async () => {
    const session = Session.create("main");
    await repo.add(session);
    session.recordTurn({
      provider: "openai",
      modelThreadId: "t-1",
      checkpoint: { turnId: "turn-1", checkpointId: "c-1" },
    });
    session.recordTurn({
      provider: "openai",
      modelThreadId: "t-1",
      checkpoint: { turnId: "turn-2", checkpointId: "c-2" },
    });
    await repo.save(session);
    expect((await repo.deprecatedCheckpoint(session.id, "turn-1"))?.checkpointId).toBe("c-1");
    expect((await repo.deprecatedCheckpoint(session.id, "turn-2"))?.checkpointId).toBe("c-2");
  });

  it("save() replaces a turn's checkpoint when the turn is recorded again", async () => {
    const session = Session.create("main");
    await repo.add(session);
    session.recordTurn({
      provider: "openai",
      modelThreadId: "t-1",
      checkpoint: { turnId: "turn-1", checkpointId: "c-1" },
    });
    await repo.save(session);
    session.recordTurn({
      provider: "openai",
      modelThreadId: "t-2",
      checkpoint: { turnId: "turn-1", checkpointId: "c-2" },
    });
    await repo.save(session);

    const rows = await testDb.db.select().from(sessionTurnCheckpoints);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ modelThreadId: "t-2", checkpointId: "c-2" });
  });

  it("save() clears a stale thread and model when a provider has no thread yet", async () => {
    const session = Session.create("main");
    await repo.add(session);
    session.recordTurn({ provider: "openai", modelThreadId: "codex-thread-1", model: "gpt-5" });
    await repo.save(session);
    session.recordTurn({ provider: "anthropic" });
    await repo.save(session);

    const found = (await repo.session(session.id))!;
    expect(found.provider).toBe("anthropic");
    expect(found.modelThreadId).toBeNull();
    expect(found.model).toBeNull();
  });

  it("save() refuses a session that was never added, and keeps its changes for a retry", async () => {
    const session = Session.create("main");
    session.recordTurn({
      provider: "openai",
      modelThreadId: "t-1",
      checkpoint: { turnId: "turn-1", checkpointId: "c-1" },
    });
    await expect(repo.save(session)).rejects.toThrow(/never added/);

    // The failed save consumed nothing: the next one writes the turn and its checkpoint.
    await repo.add(Session.create("main", { deprecatedId: session.id }));
    await repo.save(session);
    expect((await repo.session(session.id))!.provider).toBe("openai");
    expect((await repo.deprecatedCheckpoint(session.id, "turn-1"))?.checkpointId).toBe("c-1");
  });

  it("save() writes only the facts each instance changed, so two instances keep both", async () => {
    const session = Session.create("main", { continuityKey: "k" });
    await repo.add(session);
    const streaming = (await repo.session(session.id))!;
    const recording = (await repo.session(session.id))!;

    recording.recordTurn({ provider: "openai", modelThreadId: "t-1", model: "gpt-5" });
    await repo.save(recording);
    streaming.touch();
    await repo.save(streaming);

    const found = (await repo.session(session.id))!;
    expect(found.provider).toBe("openai");
    expect(found.modelThreadId).toBe("t-1");
    expect(seconds(found.lastActiveAt)).toBe(seconds(streaming.lastActiveAt));
  });

  it("replace() carries over the chat the retired session's row names", async () => {
    const session = Session.create("main", { continuityKey: "k" });
    await repo.add(session);
    // The chat side records the link on the row after open.
    await testDb.db.update(sessions).set({ chatId: "chat-1" }).where(eq(sessions.id, session.id));

    const successor = session.replace();
    await repo.replace(session, successor);
    const [row] = await testDb.db.select().from(sessions).where(eq(sessions.id, successor.id));
    expect(row?.chatId).toBe("chat-1");
  });

  it("add() and save() never write a chat", async () => {
    const session = Session.create("main", { continuityKey: "k" });
    await repo.add(session);
    await testDb.db.update(sessions).set({ chatId: "chat-1" }).where(eq(sessions.id, session.id));
    session.recordTurn({ provider: "openai", modelThreadId: "t-1", model: "gpt-5" });
    await repo.save(session);
    const [row] = await testDb.db.select().from(sessions).where(eq(sessions.id, session.id));
    expect(row?.chatId).toBe("chat-1");
  });

  it("replace() retires the session and every duplicate, and adds the successor", async () => {
    const current = Session.create("main", { continuityKey: "k" });
    await repo.add(current);
    await testDb.db.update(sessions).set({ chatId: "chat-1" }).where(eq(sessions.id, current.id));
    // A duplicate active row, as older data can hold.
    await testDb.db.insert(sessions).values({
      id: "dup",
      agentName: "main",
      channelThreadKey: "k",
      createdAt: new Date("2020-01-01T00:00:00Z"),
      lastActiveAt: new Date("2020-01-01T00:00:00Z"),
      status: "active",
    });
    // Another agent's session under the same continuity key is left alone.
    const other = Session.create("other", { continuityKey: "k" });
    await repo.add(other);

    const successor = current.replace();
    await repo.replace(current, successor);

    const rows = await testDb.db.select().from(sessions).where(eq(sessions.channelThreadKey, "k"));
    const byId = Object.fromEntries(rows.map((row) => [row.id, row]));
    expect(byId[current.id].status).toBe("completed");
    expect(byId.dup.status).toBe("completed");
    expect(byId[other.id].status).toBe("active");
    expect(byId[successor.id]).toMatchObject({
      status: "active",
      agentName: "main",
      channelThreadKey: "k",
      chatId: "chat-1",
      provider: null,
      modelThreadId: null,
    });
    expect((await repo.current("k", "main"))?.id).toBe(successor.id);
  });

  it("replace() writes the retired session's last turn and checkpoint", async () => {
    const current = Session.create("main", { continuityKey: "k" });
    await repo.add(current);
    current.recordTurn({
      provider: "openai",
      modelThreadId: "t-1",
      checkpoint: { turnId: "turn-1", checkpointId: "c-1" },
    });
    const successor = current.replace();
    await repo.replace(current, successor);

    expect((await repo.session(current.id))!.modelThreadId).toBe("t-1");
    expect((await repo.deprecatedCheckpoint(current.id, "turn-1"))?.checkpointId).toBe("c-1");
  });

  it("replace() writes a turn the successor recorded before the reset was written", async () => {
    const current = Session.create("main", { continuityKey: "k" });
    await repo.add(current);
    const successor = current.replace();
    successor.recordTurn({
      provider: "openai",
      modelThreadId: "t-2",
      checkpoint: { turnId: "turn-1", checkpointId: "c-1" },
    });
    await repo.replace(current, successor);

    expect((await repo.session(successor.id))!.modelThreadId).toBe("t-2");
    expect((await repo.deprecatedCheckpoint(successor.id, "turn-1"))?.checkpointId).toBe("c-1");
    expect(successor.pendingChanges().checkpoints).toEqual([]);
  });

  it("replace() refuses a session that was not completed, or a stranger as successor", async () => {
    const current = Session.create("main", { continuityKey: "k" });
    await repo.add(current);
    await expect(
      repo.replace(current, Session.create("main", { continuityKey: "k" })),
    ).rejects.toThrow(/not completed/);

    const successor = current.replace();
    await expect(
      repo.replace(current, Session.create("main", { continuityKey: "k2" })),
    ).rejects.toThrow(/does not succeed/);
    await repo.replace(current, successor);
  });
});

describe("DrizzleSessionRepository under another connection's write lock", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "session-repo-lock-"));
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  /**
   * Runs `act` against a repository on a file-backed WAL database, as the live
   * one is, while another connection holds the write lock for a moment. The
   * repository blocks this thread while it waits, so the other connection
   * lives in its own process. It takes the write lock, then lets go.
   */
  async function whileLocked(
    act: (repo: DrizzleSessionRepository) => Promise<void>,
    prepare: (repo: DrizzleSessionRepository) => Promise<void> = async () => undefined,
  ): Promise<void> {
    const template = createTestDb();
    const file = join(dir, "rome.db");
    writeFileSync(
      file,
      (template.db as unknown as { $client: Database.Database }).$client.serialize(),
    );
    template.close();
    const sqlite = new Database(file);
    sqlite.pragma("journal_mode = WAL");
    const repo = new DrizzleSessionRepository(drizzle(sqlite, { schema }) as unknown as DrizzleDb);
    await prepare(repo);

    const driver = createRequire(import.meta.url).resolve("better-sqlite3");
    const holder = spawn(
      process.execPath,
      [
        "-e",
        `const db = require(process.argv[1])(process.argv[2]);
         db.pragma("journal_mode = WAL");
         db.exec("BEGIN IMMEDIATE");
         console.log("locked");
         setTimeout(() => { db.exec("COMMIT"); db.close(); }, 400);`,
        driver,
        file,
      ],
      { stdio: ["ignore", "pipe", "inherit"] },
    );
    const exited = new Promise<void>((resolve) => holder.on("exit", () => resolve()));
    try {
      await new Promise<void>((resolve, reject) => {
        holder.on("error", reject);
        holder.stdout.once("data", () => resolve());
      });
      await act(repo);
    } finally {
      holder.kill();
      await exited;
      sqlite.close();
    }
  }

  it("save() waits for the lock instead of failing with 'database is locked'", async () => {
    const session = Session.create("main");
    await whileLocked(
      async (repo) => {
        await expect(repo.save(session)).resolves.toBeUndefined();
      },
      async (repo) => {
        await repo.add(session);
        session.touch();
      },
    );
  });

  it("add() waits for the lock instead of failing with 'database is locked'", async () => {
    const session = Session.create("main", { continuityKey: "k" });
    await whileLocked(async (repo) => {
      await expect(repo.add(session)).resolves.toBeUndefined();
      expect((await repo.session(session.id))?.snapshot().id).toBe(session.id);
      // The active-session check still runs once the lock is won.
      await expect(repo.add(Session.create("main", { continuityKey: "k" }))).rejects.toBeInstanceOf(
        ActiveSessionExistsError,
      );
    });
  });
});
