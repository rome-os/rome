import { describe, expect, it, afterEach, beforeEach, rs } from "@rstest/core";
import { eq } from "drizzle-orm";
import { createTestDb, type TestDb } from "../test/helpers.js";
import { romeAgentMessages, romeSessions } from "../db/schema.js";
import { WebChatRepository } from "../db/repositories/webchat.js";
import {
  AgentTraceRecorder,
  recordAgentTraceBestEffort,
  resolveRomeSessionId,
  resolveRomeSessionType,
} from "./agent-trace-recorder.js";

describe("resolveRomeSessionId", () => {
  it("resolves webchat, channel, and action runtime identities", () => {
    expect(
      resolveRomeSessionId({
        agentName: "main",
        agentSessionId: "runtime-webchat-session",
        threadContext: { channel: "webchat", threadId: "durable-webchat-session" },
      }),
    ).toBe("durable-webchat-session");
    expect(
      resolveRomeSessionId({
        agentName: "main",
        agentSessionId: "runtime-channel-session",
        threadContext: { channel: "telegram", threadId: "thread-1" },
      }),
    ).toBe("channel:telegram:thread-1");
    expect(
      resolveRomeSessionId({
        agentName: "researcher",
        agentSessionId: "runtime-action-session",
        actionContext: { executionId: "exec-1" },
      }),
    ).toBe("action:exec-1:researcher");
  });
});

describe("resolveRomeSessionType", () => {
  it("classifies ordinary webchat, channel, and action turns", () => {
    expect(
      resolveRomeSessionType({ threadContext: { channel: "webchat", threadId: "chat-1" } }),
    ).toBe("webchat");
    expect(
      resolveRomeSessionType({ threadContext: { channel: "telegram", threadId: "thread-1" } }),
    ).toBe("channel");
    expect(resolveRomeSessionType({})).toBe("action");
  });
});

describe("AgentTraceRecorder", () => {
  let testDb: TestDb;
  let repo: WebChatRepository;

  beforeEach(() => {
    testDb = createTestDb();
    repo = new WebChatRepository(testDb.db);
  });

  afterEach(() => {
    testDb.close();
  });

  it("persists non-webchat trace blocks under the canonical channel Rome session", async () => {
    const recorder = new AgentTraceRecorder({
      webchatRepo: repo,
      agentName: "sentinel",
      agentSessionId: "agent-session-1",
      channelThreadKey: "telegram:thread-1",
      turnId: "turn-1",
      threadContext: {
        channel: "telegram",
        threadId: "thread-1",
        threadName: "Ops",
        threadType: "group",
        projectName: "alpha",
        projectPath: "alpha",
      },
    });

    await recorder.record({
      type: "turn_start",
      turnId: "turn-1",
      sessionId: "provider-session-1",
      userPrompt: "hello",
    });
    await recorder.record({ type: "text_delta", content: "ignored" });
    await recorder.record({ type: "result", content: "done" });

    const sessionRows = await testDb.db
      .select()
      .from(romeSessions)
      .where(eq(romeSessions.id, "channel:telegram:thread-1"));
    expect(sessionRows[0]).toMatchObject({
      type: "channel",
      sourceChannel: "telegram",
      sourceThreadId: "thread-1",
      sourceThreadName: "Ops",
      sourceThreadType: "group",
      projectName: "alpha",
      projectPath: "alpha",
      agentName: "sentinel",
    });

    const messageRows = await testDb.db
      .select()
      .from(romeAgentMessages)
      .where(eq(romeAgentMessages.id, "trace-message:channel:telegram:thread-1:turn-1"));
    expect(messageRows[0]).toMatchObject({
      sessionId: "channel:telegram:thread-1",
      turnId: "turn-1",
      role: "trace",
      triggerKind: null,
      triggerName: null,
      triggerActionName: null,
      triggerExecutionId: null,
      rootActionExecutionId: null,
      parentActionExecutionId: null,
    });

    const trace = await repo.getTraceContentByTurn("channel:telegram:thread-1", "turn-1");
    expect(JSON.parse(trace?.content ?? "[]")).toEqual([
      expect.objectContaining({ type: "turn_start", turnId: "turn-1" }),
      expect.objectContaining({ type: "result", content: "done" }),
    ]);

    const transcript = await repo.getMessages("channel:telegram:thread-1");
    expect(transcript.map((message) => message.role)).toEqual(["user", "trace", "assistant"]);
    expect(transcript[0]).toMatchObject({
      id: "transcript-message:channel:telegram:thread-1:turn-1:user",
      turnId: "turn-1",
      content: JSON.stringify([{ type: "text", content: "hello" }]),
    });
    expect(transcript[2]).toMatchObject({
      id: "transcript-message:channel:telegram:thread-1:turn-1:assistant",
      turnId: "turn-1",
      content: JSON.stringify([{ type: "text", content: "done" }]),
    });
  });

  it("retries session creation after a transient ensure failure", async () => {
    const ensureSpy = rs
      .spyOn(repo, "ensureRomeSession")
      .mockRejectedValueOnce(new Error("sqlite busy"));
    const recorder = new AgentTraceRecorder({
      webchatRepo: repo,
      agentName: "sentinel",
      agentSessionId: "agent-session-retry",
      channelThreadKey: "telegram:thread-retry",
      turnId: "turn-retry",
      threadContext: {
        channel: "telegram",
        threadId: "thread-retry",
        threadName: "Retry Ops",
        threadType: "group",
      },
    });

    await expect(
      recorder.record({
        type: "turn_start",
        turnId: "turn-retry",
        sessionId: "provider-session-retry",
        userPrompt: "hello",
      }),
    ).rejects.toThrow("sqlite busy");

    await recorder.record({
      type: "turn_start",
      turnId: "turn-retry",
      sessionId: "provider-session-retry",
      userPrompt: "hello",
    });

    expect(ensureSpy).toHaveBeenCalledTimes(2);
    const sessionRows = await testDb.db
      .select()
      .from(romeSessions)
      .where(eq(romeSessions.id, "channel:telegram:thread-retry"));
    expect(sessionRows[0]).toMatchObject({
      type: "channel",
      sourceChannel: "telegram",
      sourceThreadId: "thread-retry",
    });
  });

  it("persists action-triggered channel traces under the canonical channel session with message trigger metadata", async () => {
    const recorder = new AgentTraceRecorder({
      webchatRepo: repo,
      agentName: "sentinel",
      agentSessionId: "agent-session-2",
      channelThreadKey: "telegram:thread-1",
      turnId: "turn-2",
      threadContext: {
        channel: "telegram",
        threadId: "thread-1",
        threadName: "Ops",
        threadType: "group",
        projectName: "alpha",
        projectPath: "alpha",
      },
      actionContext: {
        actionName: "summon",
        executionId: "exec-2",
        rootExecutionId: "exec-1",
        parentExecutionId: "exec-parent",
      },
    });

    await recorder.record({
      type: "turn_start",
      turnId: "turn-2",
      sessionId: "provider-session-2",
      userPrompt: "hello from action",
    });

    const sessionRows = await testDb.db
      .select()
      .from(romeSessions)
      .where(eq(romeSessions.id, "channel:telegram:thread-1"));
    expect(sessionRows[0]).toMatchObject({
      type: "channel",
      sourceChannel: "telegram",
      sourceThreadId: "thread-1",
      sourceThreadName: "Ops",
      sourceThreadType: "group",
      projectName: "alpha",
      projectPath: "alpha",
      agentName: "sentinel",
      triggerKind: null,
      triggerName: null,
      triggerActionName: null,
      triggerExecutionId: null,
      rootActionExecutionId: null,
      parentActionExecutionId: null,
    });

    const messageRows = await testDb.db
      .select()
      .from(romeAgentMessages)
      .where(eq(romeAgentMessages.id, "trace-message:channel:telegram:thread-1:turn-2"));
    expect(messageRows[0]).toMatchObject({
      sessionId: "channel:telegram:thread-1",
      turnId: "turn-2",
      role: "trace",
      triggerKind: "action",
      triggerName: "summon",
      triggerActionName: "summon",
      triggerExecutionId: "exec-2",
      rootActionExecutionId: "exec-1",
      parentActionExecutionId: "exec-parent",
    });

    const trace = await repo.getTraceContentByTurn("channel:telegram:thread-1", "turn-2");
    expect(JSON.parse(trace?.content ?? "[]")).toEqual([
      expect.objectContaining({ type: "turn_start", turnId: "turn-2" }),
    ]);

    const transcript = await repo.getMessages("channel:telegram:thread-1");
    expect(transcript.map((message) => message.role)).toEqual(["user", "trace"]);
    expect(transcript[0]).toMatchObject({
      turnId: "turn-2",
      content: JSON.stringify([{ type: "text", content: "hello from action" }]),
    });
  });

  it("persists action-only traces under an action Rome session", async () => {
    const recorder = new AgentTraceRecorder({
      webchatRepo: repo,
      agentName: "sentinel",
      channelThreadKey: "action:ad-hoc",
      turnId: "turn-action-only",
      actionContext: {
        actionName: "summon",
        executionId: "exec-action-only",
        rootExecutionId: "exec-root",
        parentExecutionId: "exec-parent",
      },
    });

    await recorder.record({
      type: "turn_start",
      turnId: "turn-action-only",
      sessionId: "provider-session-action-only",
      userPrompt: "run action",
    });

    const sessionRows = await testDb.db
      .select()
      .from(romeSessions)
      .where(eq(romeSessions.id, "action:exec-action-only:sentinel"));
    expect(sessionRows[0]).toMatchObject({
      type: "action",
      sourceChannel: null,
      sourceThreadId: null,
      agentName: "sentinel",
      triggerKind: "action",
      triggerName: "summon",
      triggerActionName: "summon",
      triggerExecutionId: "exec-action-only",
      rootActionExecutionId: "exec-root",
      parentActionExecutionId: "exec-parent",
    });

    const transcript = await repo.getMessages("action:exec-action-only:sentinel");
    expect(transcript.map((message) => message.role)).toEqual(["user", "trace"]);
  });

  it("does not duplicate webchat transcript rows for existing sessions", async () => {
    await repo.createSession("sess-webchat", "Webchat");
    const recorder = new AgentTraceRecorder({
      webchatRepo: repo,
      agentName: "main",
      turnId: "turn-webchat",
      existingSessionId: "sess-webchat",
      traceMessageId: "trace-webchat",
    });

    await recorder.record({
      type: "turn_start",
      turnId: "turn-webchat",
      sessionId: "provider-session-webchat",
      userPrompt: "hello",
    });
    await recorder.record({ type: "result", content: "done" });

    const messages = await repo.getMessages("sess-webchat");
    expect(messages).toEqual([
      expect.objectContaining({
        id: "trace-webchat",
        role: "trace",
        turnId: "turn-webchat",
      }),
    ]);
  });

  it("rolls back transcript rows when the trace batch fails", async () => {
    await repo.ensureRomeSession({
      id: "channel:atomic-session",
      type: "channel",
      name: "Atomic",
      agentName: "sentinel",
    });
    await repo.appendTraceBlocks({
      messageId: "trace-message:channel:atomic-session:turn-atomic",
      sessionId: "channel:atomic-session",
      turnId: "turn-atomic",
      startSeq: 0,
      blocks: [{ type: "turn_start", turnId: "turn-atomic" }],
    });

    await expect(
      repo.appendTraceBlocks({
        messageId: "trace-message:channel:atomic-session:turn-atomic",
        sessionId: "channel:atomic-session",
        turnId: "turn-atomic",
        startSeq: 0,
        blocks: [{ type: "turn_start", turnId: "turn-atomic" }],
        transcriptMessages: [
          {
            id: "transcript-message:channel:atomic-session:turn-atomic:user",
            sessionId: "channel:atomic-session",
            turnId: "turn-atomic",
            role: "user",
            content: JSON.stringify([{ type: "text", content: "hello" }]),
          },
        ],
      }),
    ).rejects.toThrow();

    const transcript = await repo.getMessages("channel:atomic-session");
    expect(transcript.map((message) => message.role)).toEqual(["trace"]);
  });

  it("keeps recorder failures best-effort", async () => {
    const warn = rs.fn();
    const recorder = {
      record: rs.fn(async () => {
        throw new Error("sqlite busy");
      }),
    } as unknown as AgentTraceRecorder;

    await expect(
      recordAgentTraceBestEffort(
        recorder,
        { type: "result", content: "done" },
        { warn },
        { turnId: "turn-best-effort", source: "test" },
      ),
    ).resolves.toBeUndefined();

    expect(recorder.record).toHaveBeenCalledWith({ type: "result", content: "done" });
    expect(warn).toHaveBeenCalledWith("failed to persist agent trace", {
      turnId: "turn-best-effort",
      source: "test",
      error: "sqlite busy",
    });
  });
});
