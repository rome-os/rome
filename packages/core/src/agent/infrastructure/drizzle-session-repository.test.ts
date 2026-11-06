import { afterEach, beforeEach, describe, expect, it } from "@rstest/core";
import { eq } from "drizzle-orm";
import {
  claimLegacyArtifactName,
  createEmptyLegacyArtifactBindings,
  formatArtifactId,
} from "../../apps/artifact-id.js";
import { sessions, sessionTurnCheckpoints } from "../../db/schema.js";
import { createTestDb, type TestDb } from "../../test/helpers.js";
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
    repo = new DrizzleSessionRepository(testDb.db, {
      legacyBindings: createEmptyLegacyArtifactBindings(),
    });
  });

  afterEach(() => testDb.close());

  it("add() stores a session that session() reads back", async () => {
    const session = Session.create("main", {
      continuityKey: "telegram:thread-1",
      workingDir: "/w",
      deprecatedChatId: "chat-1",
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
      providerThreadId: "t-1",
      model: "gpt-5",
      checkpoint: { turnId: "turn-1", checkpointId: "c-1" },
    });
    await repo.add(session);

    const found = (await repo.session("fork-1"))!;
    expect(found.provider).toBe("openai");
    expect(found.providerThreadId).toBe("t-1");
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

  it("current() matches an agent under its legacy name without rewriting the row", async () => {
    const bindings = createEmptyLegacyArtifactBindings();
    claimLegacyArtifactName(
      bindings,
      "agent",
      "reviewer",
      formatArtifactId("code-review", "reviewer"),
    );
    repo = new DrizzleSessionRepository(testDb.db, { legacyBindings: bindings });
    const legacy = Session.create("reviewer", { continuityKey: "webchat:review" });
    await repo.add(legacy);

    const found = await repo.current("webchat:review", "code-review:reviewer");
    expect(found?.id).toBe(legacy.id);
    expect(found?.agentName).toBe("reviewer");
  });

  it("save() writes what a turn ran on, its checkpoint, and a move", async () => {
    const session = Session.create("main", { continuityKey: "k" });
    await repo.add(session);

    session.recordTurn({
      provider: "openai",
      providerThreadId: "t-1",
      model: "gpt-5",
      reasoningEffort: "xhigh",
      checkpoint: { turnId: "turn-1", checkpointId: "c-1" },
    });
    session.moveTo("/elsewhere");
    session.touch();
    await repo.save(session);

    const found = (await repo.session(session.id))!;
    expect(found.provider).toBe("openai");
    expect(found.providerThreadId).toBe("t-1");
    expect(found.model).toBe("gpt-5");
    expect(found.reasoningEffort).toBe("xhigh");
    expect(found.workingDir).toBe("/elsewhere");
    expect(await repo.deprecatedCheckpoint(session.id, "turn-1")).toEqual({
      sessionId: session.id,
      turnId: "turn-1",
      provider: "openai",
      providerThreadId: "t-1",
      checkpointId: "c-1",
    });
    expect(await repo.deprecatedCheckpoint(session.id, "turn-2")).toBeNull();
  });

  it("save() writes every turn's checkpoint recorded since the last save", async () => {
    const session = Session.create("main");
    await repo.add(session);
    session.recordTurn({
      provider: "openai",
      providerThreadId: "t-1",
      checkpoint: { turnId: "turn-1", checkpointId: "c-1" },
    });
    session.recordTurn({
      provider: "openai",
      providerThreadId: "t-1",
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
      providerThreadId: "t-1",
      checkpoint: { turnId: "turn-1", checkpointId: "c-1" },
    });
    await repo.save(session);
    session.recordTurn({
      provider: "openai",
      providerThreadId: "t-2",
      checkpoint: { turnId: "turn-1", checkpointId: "c-2" },
    });
    await repo.save(session);

    const rows = await testDb.db.select().from(sessionTurnCheckpoints);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ providerThreadId: "t-2", checkpointId: "c-2" });
  });

  it("save() clears a stale thread and model when a provider has no thread yet", async () => {
    const session = Session.create("main");
    await repo.add(session);
    session.recordTurn({ provider: "openai", providerThreadId: "codex-thread-1", model: "gpt-5" });
    await repo.save(session);
    session.recordTurn({ provider: "anthropic" });
    await repo.save(session);

    const found = (await repo.session(session.id))!;
    expect(found.provider).toBe("anthropic");
    expect(found.providerThreadId).toBeNull();
    expect(found.model).toBeNull();
  });

  it("save() refuses a session that was never added, and keeps its changes for a retry", async () => {
    const session = Session.create("main");
    session.recordTurn({
      provider: "openai",
      providerThreadId: "t-1",
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

    recording.recordTurn({ provider: "openai", providerThreadId: "t-1", model: "gpt-5" });
    await repo.save(recording);
    streaming.touch();
    await repo.save(streaming);

    const found = (await repo.session(session.id))!;
    expect(found.provider).toBe("openai");
    expect(found.providerThreadId).toBe("t-1");
    expect(seconds(found.lastActiveAt)).toBe(seconds(streaming.lastActiveAt));
  });

  it("save() never records a chat over one another instance recorded first", async () => {
    const session = Session.create("main");
    await repo.add(session);
    const first = (await repo.session(session.id))!;
    const second = (await repo.session(session.id))!;
    first.deprecatedRecordChat("chat-1");
    expect(second.deprecatedRecordChat("chat-2")).toBe(true);
    await repo.save(first);
    await repo.save(second);
    expect((await repo.session(session.id))!.deprecatedChatId).toBe("chat-1");
  });

  it("replace() carries the chat over from a stale instance that never saw it recorded", async () => {
    const session = Session.create("main", { continuityKey: "k" });
    await repo.add(session);
    const stale = (await repo.session(session.id))!;
    const other = (await repo.session(session.id))!;
    other.deprecatedRecordChat("chat-1");
    await repo.save(other);

    const successor = stale.replace();
    expect(successor.deprecatedChatId).toBeNull();
    await repo.replace(stale, successor);
    expect((await repo.session(successor.id))!.deprecatedChatId).toBe("chat-1");
    expect(successor.deprecatedChatId).toBe("chat-1");
  });

  it("replace() keeps the chat the caller named over the retired session's", async () => {
    const session = Session.create("main", { continuityKey: "k", deprecatedChatId: "chat-1" });
    await repo.add(session);
    const successor = session.replace({ deprecatedChatId: "chat-3" });
    await repo.replace(session, successor);
    expect((await repo.session(successor.id))!.deprecatedChatId).toBe("chat-3");
    expect(successor.deprecatedChatId).toBe("chat-3");
  });

  it("replace() retires the session and every duplicate, and adds the successor", async () => {
    const current = Session.create("main", { continuityKey: "k", deprecatedChatId: "chat-1" });
    await repo.add(current);
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
      providerThreadId: null,
    });
    expect((await repo.current("k", "main"))?.id).toBe(successor.id);
  });

  it("replace() writes the retired session's last turn and checkpoint", async () => {
    const current = Session.create("main", { continuityKey: "k" });
    await repo.add(current);
    current.recordTurn({
      provider: "openai",
      providerThreadId: "t-1",
      checkpoint: { turnId: "turn-1", checkpointId: "c-1" },
    });
    const successor = current.replace();
    await repo.replace(current, successor);

    expect((await repo.session(current.id))!.providerThreadId).toBe("t-1");
    expect((await repo.deprecatedCheckpoint(current.id, "turn-1"))?.checkpointId).toBe("c-1");
  });

  it("replace() writes a turn the successor recorded before the reset was written", async () => {
    const current = Session.create("main", { continuityKey: "k" });
    await repo.add(current);
    const successor = current.replace();
    successor.recordTurn({
      provider: "openai",
      providerThreadId: "t-2",
      checkpoint: { turnId: "turn-1", checkpointId: "c-1" },
    });
    await repo.replace(current, successor);

    expect((await repo.session(successor.id))!.providerThreadId).toBe("t-2");
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
