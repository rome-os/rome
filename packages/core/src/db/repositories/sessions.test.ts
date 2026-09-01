import { describe, it, expect, beforeEach, afterEach } from "@rstest/core";
import { createTestDb, type TestDb } from "../../test/helpers.js";
import { SessionsRepository } from "./sessions.js";
import { sessions } from "../schema.js";
import { and, eq } from "drizzle-orm";

describe("SessionsRepository", () => {
  let testDb: TestDb;
  let repo: SessionsRepository;

  beforeEach(() => {
    testDb = createTestDb();
    repo = new SessionsRepository(testDb.db);
  });

  afterEach(() => {
    testDb.close();
  });

  it("create() inserts session", async () => {
    const id = await repo.create({
      agentName: "sentinel",
      channelThreadKey: "telegram:thread-1",
    });

    expect(id).toBeDefined();
    const session = await repo.findById(id);
    expect(session).not.toBeNull();
    expect(session!.agentName).toBe("sentinel");
    expect(session!.channelThreadKey).toBe("telegram:thread-1");
    expect(session!.status).toBe("active");
  });

  it("setProviderInfo() persists provider + thread, and CLEARS a stale thread when none is given", async () => {
    const id = await repo.create({ agentName: "main", channelThreadKey: "webchat:p" });

    // Conversation runs on Codex first.
    await repo.setProviderInfo(id, "openai", "codex-thread-1");
    let row = await repo.findById(id);
    expect(row!.provider).toBe("openai");
    expect(row!.providerThreadId).toBe("codex-thread-1");

    // Then it switches to Anthropic before Claude establishes its own thread.
    // The old Codex thread id must NOT be left behind (would be replayed on resume).
    await repo.setProviderInfo(id, "anthropic");
    row = await repo.findById(id);
    expect(row!.provider).toBe("anthropic");
    expect(row!.providerThreadId).toBeNull();
  });

  it("setProviderInfo() records the session model pin beside the provider identity", async () => {
    // The concrete model that produced a turn is persisted on the
    // session row. A fresh session has no pin.
    const id = await repo.create({ agentName: "main", channelThreadKey: "webchat:p" });
    let row = await repo.findById(id);
    expect(row!.model).toBeNull();

    await repo.setProviderInfo(id, "openai", "codex-thread-1", "gpt-5.6-terra");
    row = await repo.findById(id);
    expect(row!.model).toBe("gpt-5.6-terra");

    // A backend swap re-writes the whole identity: a model claim from the old
    // backend must not survive a write that doesn't restate it.
    await repo.setProviderInfo(id, "anthropic");
    row = await repo.findById(id);
    expect(row!.provider).toBe("anthropic");
    expect(row!.model).toBeNull();
  });

  it("persists and updates provider checkpoints for individual turns", async () => {
    const sessionId = await repo.create({ agentName: "main", channelThreadKey: "webchat:p" });

    await repo.setTurnCheckpoint({
      sessionId,
      turnId: "turn-2",
      provider: "openai",
      providerThreadId: "provider-thread",
      checkpointId: "provider-turn-2",
    });

    expect(await repo.getTurnCheckpoint(sessionId, "turn-2")).toMatchObject({
      sessionId,
      turnId: "turn-2",
      provider: "openai",
      providerThreadId: "provider-thread",
      checkpointId: "provider-turn-2",
    });

    await repo.setTurnCheckpoint({
      sessionId,
      turnId: "turn-2",
      provider: "openai",
      providerThreadId: "provider-thread",
      checkpointId: "replacement-provider-turn-2",
    });

    expect(await repo.getTurnCheckpoint(sessionId, "turn-2")).toMatchObject({
      checkpointId: "replacement-provider-turn-2",
    });
    expect(await repo.getTurnCheckpoint(sessionId, "missing-turn")).toBeNull();
  });

  it("findByChannelThreadKey() returns an active session", async () => {
    const id = await repo.create({
      agentName: "sentinel",
      channelThreadKey: "telegram:thread-1",
    });

    const found = await repo.findByChannelThreadKey("telegram:thread-1");
    expect(found).not.toBeNull();
    expect(found!.id).toBe(id);
  });

  it("findActiveByThreadKey() ignores completed sessions", async () => {
    const id = await repo.create({
      agentName: "sentinel",
      channelThreadKey: "telegram:thread-1",
    });
    await repo.complete(id);

    const found = await repo.findByChannelThreadKey("telegram:thread-1");
    expect(found).toBeNull();
  });

  it("findByChannelThreadKey() keeps idle sessions reusable", async () => {
    const id = await repo.create({
      agentName: "sentinel",
      channelThreadKey: "telegram:thread-1",
    });

    // Idle time is observability data, not a validity predicate.
    const tenMinutesAgo = new Date(Date.now() - 10 * 60 * 1000);
    await testDb.db
      .update(sessions)
      .set({ lastActiveAt: tenMinutesAgo })
      .where(eq(sessions.id, id));

    const found = await repo.findByChannelThreadKey("telegram:thread-1");
    expect(found?.id).toBe(id);
    expect(found).not.toBeNull();
    expect(found!.id).toBe(id);
  });

  it("updateLastActive() updates timestamp", async () => {
    const id = await repo.create({
      agentName: "sentinel",
      channelThreadKey: "telegram:thread-1",
    });

    const before = await repo.findById(id);
    // Small delay to make sure timestamp changes
    await new Promise((r) => setTimeout(r, 10));
    await repo.touch(id);

    const after = await repo.findById(id);
    expect(after!.lastActiveAt.getTime()).toBeGreaterThanOrEqual(before!.lastActiveAt.getTime());
  });

  it("updateStatus() changes status", async () => {
    const id = await repo.create({
      agentName: "sentinel",
      channelThreadKey: "telegram:thread-1",
    });

    await repo.complete(id);
    const session = await repo.findById(id);
    expect(session!.status).toBe("completed");
  });

  it("rotates every duplicate active row for the exact agent and thread atomically", async () => {
    await repo.create({
      id: "old-1",
      agentName: "main",
      channelThreadKey: "telegram:thread-1",
    });
    await repo.create({
      id: "old-2",
      agentName: "main",
      channelThreadKey: "telegram:thread-1",
    });
    await repo.create({
      id: "other-agent",
      agentName: "sentinel",
      channelThreadKey: "telegram:thread-1",
    });

    const replacement = await repo.rotateProviderGeneration({
      agentName: "main",
      channelThreadKey: "telegram:thread-1",
      newSessionId: "fresh",
    });

    expect(replacement).toMatchObject({
      id: "fresh",
      status: "active",
      provider: null,
      providerThreadId: null,
      model: null,
    });
    expect((await repo.findById("old-1"))?.status).toBe("completed");
    expect((await repo.findById("old-2"))?.status).toBe("completed");
    expect((await repo.findById("other-agent"))?.status).toBe("active");
    const active = await testDb.db
      .select()
      .from(sessions)
      .where(
        and(
          eq(sessions.agentName, "main"),
          eq(sessions.channelThreadKey, "telegram:thread-1"),
          eq(sessions.status, "active"),
        ),
      );
    expect(active.map((row) => row.id)).toEqual(["fresh"]);
  });
});
