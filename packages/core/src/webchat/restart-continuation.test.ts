import { afterEach, beforeEach, describe, expect, it, rs } from "@rstest/core";
import { eq } from "drizzle-orm";
import { createBackendTurnRunner } from "../actions/backend-turn.js";
import type { Channel } from "../chats/connected-accounts/connected-account.js";
import { romeAgentMessages, romeSessions } from "../db/schema.js";
import { createMockAgentRunner, createTestDb, type TestDb } from "../test/helpers.js";
import { ChatsWebChatRepository } from "./chats-webchat-repository.js";
import { continueInterruptedTurns, RESTART_CONTINUATION_PROMPT } from "./restart-continuation.js";

const DAY = 24 * 60 * 60 * 1000;

describe("startup restart continuation", () => {
  let db: TestDb;
  let repo: ChatsWebChatRepository;

  beforeEach(() => {
    db = createTestDb();
    repo = new ChatsWebChatRepository(db.db);
  });
  afterEach(() => db.close());

  async function interrupted(id = "chat", prompt = "Finish the work") {
    await repo.createSession(id, id, undefined, "default", null, "default", "assistant:coder");
    await repo.recordUserInput(`${id}-input`, id, "[]");
    await repo.updateUserInput(id, {
      type: "input_status",
      inputId: `${id}-input`,
      turnId: `${id}-turn`,
      state: "consumed",
    });
    await repo.appendTraceBlocks({
      messageId: `${id}-trace`,
      sessionId: id,
      turnId: `${id}-turn`,
      startSeq: 0,
      blocks: [
        {
          type: "turn_start",
          turnId: `${id}-turn`,
          sessionId: `${id}-runtime`,
          userPrompt: prompt,
        },
      ],
    });
  }

  function backend(beforeQueuedTask?: () => Promise<void>, beforeTurn?: () => Promise<void>) {
    const agent = createMockAgentRunner([[{ type: "result", content: "Resumed" }]]);
    const send = rs.fn(async () => ({ messageId: "reply", chatId: "chat" }));
    const runner = createBackendTurnRunner({
      agentRunner: agent,
      beforeTurn,
      channel: () => ({ send: { send } }) as unknown as Channel,
    });
    runner.setWebchatRuntime({
      enqueueSessionTask: async (_id, task) => {
        await beforeQueuedTask?.();
        await task({ emit: async () => {} });
      },
    });
    return { agent, send, runner };
  }

  it("continues only this boot's cleanup results in the same chat, runtime and agent", async () => {
    await interrupted();
    const turns = await repo.endInterruptedTurns(DAY);
    expect(turns).toEqual([
      {
        agentName: "assistant:coder",
        messageId: "chat-trace",
        sessionId: "chat",
        turnId: "chat-turn",
        runtimeSessionId: "chat-runtime",
        prompt: "Finish the work",
      },
    ]);
    const { agent, send, runner } = backend();
    await continueInterruptedTurns(turns, repo, runner);
    expect(agent.calls).toHaveLength(1);
    expect(agent.calls[0]).toMatchObject({
      agentName: "assistant:coder",
      sessionId: "chat-runtime",
      initiatedBy: "system",
      inputLabel: "Restart recovery",
      prompt: expect.stringContaining(RESTART_CONTINUATION_PROMPT),
      threadContext: { channel: "webchat", threadId: "chat" },
    });
    expect(send).toHaveBeenCalledTimes(1);
    await continueInterruptedTurns(await repo.endInterruptedTurns(DAY), repo, runner);
    expect(agent.calls).toHaveLength(1);
    expect(RESTART_CONTINUATION_PROMPT).toContain("Do only what remains");
    expect(RESTART_CONTINUATION_PROMPT).toContain("ask the guardian rather than redo it");
  });

  it.each([
    { type: "routine" },
    { type: "subagent" },
    { type: "handoff" },
    { type: "channel", chatPlatform: "telegram" },
    { parentSessionId: "parent" },
    { parentTurnId: "parent-turn" },
    { ownerKey: "visitor@example.com" },
    { triggerKind: "routine" },
    { archivedAt: new Date() },
    { chatId: null },
  ])("leaves an out-of-scope chat stopped: %j", async (change) => {
    await interrupted();
    await db.db.update(romeSessions).set(change).where(eq(romeSessions.id, "chat"));
    const { agent, runner } = backend();
    await continueInterruptedTurns(await repo.endInterruptedTurns(DAY), repo, runner);
    expect(agent.calls).toHaveLength(0);
  });

  it("does not continue an automation trace inside a root chat", async () => {
    await interrupted();
    await db.db.update(romeAgentMessages).set({ triggerKind: "routine" });
    const { agent, runner } = backend();
    await continueInterruptedTurns(await repo.endInterruptedTurns(DAY), repo, runner);
    expect(agent.calls).toHaveLength(0);
  });

  it("does not continue a system turn without a guardian prompt link", async () => {
    await interrupted();
    await db.db.run("DELETE FROM agent_turn_messages");
    const { agent, runner } = backend();
    await continueInterruptedTurns(await repo.endInterruptedTurns(DAY), repo, runner);
    expect(agent.calls).toHaveLength(0);
  });

  it.each([
    false,
    true,
  ])("skips a newer guardian input, including while queued (%s)", async (whileQueued) => {
    await interrupted();
    const turns = await repo.endInterruptedTurns(DAY);
    const newer = async () => {
      await repo.recordUserInput("new-input", "chat", "[]");
    };
    const { agent, runner } = backend(whileQueued ? newer : undefined);
    if (!whileQueued) await newer();
    await continueInterruptedTurns(turns, repo, runner);
    expect(agent.calls).toHaveLength(0);
  });

  it("rechecks after preflight, not just before entering the queue", async () => {
    await interrupted();
    const turns = await repo.endInterruptedTurns(DAY);
    const { agent, runner } = backend(undefined, async () => {
      await repo.recordUserInput("new-input", "chat", "[]");
    });
    await continueInterruptedTurns(turns, repo, runner);
    expect(agent.calls).toHaveLength(0);
  });

  it("leaves a recovery cut off during dispatch stopped on the next boot", async () => {
    await interrupted();
    const firstBoot = await repo.endInterruptedTurns(DAY);
    const runAndReport = rs.fn(async (params: { prompt: string; sessionId: string }) => {
      await repo.appendTraceBlocks({
        messageId: "recovery-trace",
        sessionId: "chat",
        turnId: "recovery-turn",
        startSeq: 0,
        blocks: [
          {
            type: "turn_start",
            turnId: "recovery-turn",
            sessionId: params.sessionId,
            userPrompt: params.prompt,
          },
        ],
      });
      return "failed" as const;
    });
    await continueInterruptedTurns(firstBoot, repo, { runAndReport });
    const nextRepo = new ChatsWebChatRepository(db.db);
    const nextBoot = await nextRepo.endInterruptedTurns(DAY);
    expect(nextBoot).toHaveLength(1);
    expect(nextBoot[0]?.turnId).toBe("recovery-turn");
    await continueInterruptedTurns(nextBoot, nextRepo, { runAndReport });
    expect(runAndReport).toHaveBeenCalledTimes(1);
  });

  it("skips an older interrupted trace when a newer turn exists in the same second", async () => {
    await interrupted();
    await repo.appendTraceBlocks({
      messageId: "a-newer-trace",
      sessionId: "chat",
      turnId: "later",
      startSeq: 0,
      blocks: [
        { type: "turn_start", turnId: "later" },
        { type: "turn_end", turnId: "later", status: "completed" },
      ],
    });
    const { agent, runner } = backend();
    await continueInterruptedTurns(await repo.endInterruptedTurns(DAY), repo, runner);
    expect(agent.calls).toHaveLength(0);
  });

  it("never continues a restart recovery, even with a guardian prompt and no system_input block", async () => {
    await interrupted("chat", `<concierge_chat id="chat"/>\n${RESTART_CONTINUATION_PROMPT}`);
    const turns = await repo.endInterruptedTurns(DAY);
    expect(turns).toHaveLength(1);
    const { agent, runner } = backend();
    await continueInterruptedTurns(turns, repo, runner);
    expect(agent.calls).toHaveLength(0);
    expect((await repo.getTraceContents("chat"))[0]?.content).toContain(
      "Rome restarted while this was running",
    );
  });

  it("skips a trace without a known runtime", async () => {
    await interrupted();
    const turns = await repo.endInterruptedTurns(DAY);
    turns[0]!.runtimeSessionId = null;
    const { agent, runner } = backend();
    await continueInterruptedTurns(turns, repo, runner);
    expect(agent.calls).toHaveLength(0);
  });

  it("bounds the burst to one active continuation and never retries a failed dispatch", async () => {
    await interrupted("one");
    await interrupted("two");
    const turns = await repo.endInterruptedTurns(DAY);
    let active = 0;
    let maxActive = 0;
    const runner = {
      runAndReport: rs.fn(async () => {
        active++;
        maxActive = Math.max(maxActive, active);
        await Promise.resolve();
        active--;
        throw new Error("dispatch failed");
      }),
    };
    await continueInterruptedTurns(turns, repo, runner);
    expect(maxActive).toBe(1);
    expect(runner.runAndReport).toHaveBeenCalledTimes(2);
  });
});
