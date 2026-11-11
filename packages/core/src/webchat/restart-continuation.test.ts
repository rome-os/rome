import { afterEach, beforeEach, describe, expect, it, rs } from "@rstest/core";
import { eq } from "drizzle-orm";
import { createBackendTurnRunner } from "../apps/actions/backend-turn.js";
import type { Channel } from "../chats/connected-accounts/connected-account.js";
import { romeAgentMessages, romeSessions, sessions } from "../db/schema.js";
import { createMockAgentRunner, createTestDb, type TestDb } from "../test/helpers.js";
import { ChatsWebChatRepository } from "./chats-webchat-repository.js";
import { continueInterruptedTurns, RESTART_CONTINUATION_PROMPT } from "./restart-continuation.js";
import { continuationActor } from "./continuation-actor.js";
import { sendForCaller } from "../apps/actions/caller-notify.js";
import { guardianAuth } from "../db/schema.js";

const DAY = 24 * 60 * 60 * 1000;

describe("startup restart continuation", () => {
  let db: TestDb;
  let repo: ChatsWebChatRepository;

  beforeEach(() => {
    db = createTestDb();
    repo = new ChatsWebChatRepository(db.db);
  });
  afterEach(() => {
    rs.useRealTimers();
    db.close();
  });

  async function interrupted(
    id = "chat",
    prompt = "Finish the work",
    guardianPrompt = "Finish the work",
  ) {
    await repo.createSession(id, id, undefined, "default", null, "default", "assistant:coder");
    await repo.recordUserInput(
      `${id}-input`,
      id,
      JSON.stringify([{ type: "text", content: guardianPrompt }]),
    );
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

  it("continues as the person whose turn it was, so send_notification rings them in a shared chat", async () => {
    await db.db
      .insert(guardianAuth)
      .values({ id: "auth-1", userId: "seat-1", passwordHash: "x", createdAt: new Date() });
    await interrupted();
    const turns = await repo.endInterruptedTurns(DAY);
    const { agent, runner } = backend();
    await continueInterruptedTurns(turns, repo, runner, Date.now(), (turn) =>
      continuationActor(db.db, repo, turn),
    );
    const actor = agent.calls[0]?.actor as { kind: string } | undefined;
    expect(actor).toEqual({ kind: "guardian", userId: "seat-1", via: "loopback" });
    // The continued turn's send_notification in this shared chat.
    const pushes: unknown[] = [];
    const outcome = await sendForCaller(
      {
        send: async (content) => (
          pushes.push(content), { kind: "ok", attempted: 1, sent: 1, failed: 0 }
        ),
      },
      async () => null,
      { actor: actor as never, chatId: "chat" },
      { body: "Done" },
    );
    expect(outcome.kind).toBe("ok");
    expect(pushes).toEqual([{ body: "Done" }]);
  });

  it("names one person for a turn written by one, and no one for a turn holding two people's input", async () => {
    await interrupted();
    expect(repo.getTurnPromptSenders({ sessionId: "chat", turnId: "chat-turn" })).toEqual([
      "guardian",
    ]);
    await repo.recordUserInput(
      "chat-visitor-input",
      "chat",
      JSON.stringify([{ type: "text", content: "Me too" }]),
      { kind: "visitor", accountId: "acct-v", email: "v@example.com" },
    );
    await repo.updateUserInput("chat", {
      type: "input_status",
      inputId: "chat-visitor-input",
      turnId: "chat-turn",
      state: "consumed",
    });
    expect(repo.getTurnPromptSenders({ sessionId: "chat", turnId: "chat-turn" }).sort()).toEqual([
      "guardian",
      "visitor:acct-v",
    ]);
    expect(
      await continuationActor(db.db, repo, { sessionId: "chat", turnId: "chat-turn" }),
    ).toBeUndefined();
  });

  async function withActivity(startedAt: number, lastActivityAt: number, now: number) {
    rs.useFakeTimers({ toFake: ["Date"] });
    rs.setSystemTime(startedAt);
    await interrupted();
    rs.setSystemTime(lastActivityAt);
    await repo.appendTraceBlocks({
      messageId: "chat-trace",
      sessionId: "chat",
      turnId: "chat-turn",
      startSeq: 1,
      blocks: [
        {
          type: "tool_result",
          tool: "execute_action",
          output: "Still working",
          endedAt: new Date(lastActivityAt).toISOString(),
        },
      ],
    });
    rs.setSystemTime(now);
    return repo.endInterruptedTurns(DAY);
  }

  it("leaves the restart notice without continuing after a week of inactivity", async () => {
    const now = Date.parse("2026-11-10T12:00:00Z");
    const turns = await withActivity(now - 8 * DAY, now - 7 * DAY, now);
    expect(turns).toHaveLength(1);
    const { agent, runner } = backend();
    await continueInterruptedTurns(turns, repo, runner, now);
    expect(agent.calls).toHaveLength(0);
    expect((await repo.getTraceContents("chat"))[0]?.content).toContain(
      "Rome restarted while this was running",
    );
  });

  it("continues a turn started 30 hours ago with tool activity one minute before startup", async () => {
    const now = Date.parse("2026-11-10T12:00:00Z");
    const turns = await withActivity(now - 30 * 3600000, now - 60000, now);
    const { agent, runner } = backend();
    await continueInterruptedTurns(turns, repo, runner, now);
    expect(agent.calls).toHaveLength(1);
  });

  it("continues an old turn with recent runtime-session activity and no recent timestamped trace block", async () => {
    const now = Date.parse("2026-11-10T12:00:00Z");
    const turns = await withActivity(now - 30 * 3600000, now - 29 * 3600000, now);
    await db.db.insert(sessions).values({
      id: "chat-runtime",
      agentName: "assistant:coder",
      chatId: "chat",
      createdAt: new Date(now - 30 * 3600000),
      lastActiveAt: new Date(now - 60000),
      status: "active",
    });
    const { agent, runner } = backend();
    await continueInterruptedTurns(turns, repo, runner, now);
    expect(agent.calls).toHaveLength(1);
  });

  it.each([
    [DAY - 1, 1],
    [DAY, 0],
    [DAY + 1, 0],
  ])("with last activity %i ms ago, runs %i continuation(s)", async (inactivity, expected) => {
    const now = Date.parse("2026-11-10T12:00:00Z");
    const turns = await withActivity(now - 2 * DAY, now - inactivity, now);
    const { agent, runner } = backend();
    await continueInterruptedTurns(turns, repo, runner, now);
    expect(agent.calls).toHaveLength(expected);
  });

  it.each([
    null,
    Number.NaN,
  ])("does not continue with missing or invalid last activity (%s)", async (lastActivityAt) => {
    await interrupted();
    const turns = await repo.endInterruptedTurns(DAY);
    const { agent, runner } = backend();
    await continueInterruptedTurns(
      turns,
      {
        canContinueAfterRestart: (turn) => repo.canContinueAfterRestart(turn),
        getRestartGuardianPrompt: (turn) => repo.getRestartGuardianPrompt(turn),
        getRestartLastActivityAt: () => lastActivityAt,
      },
      runner,
      Date.now(),
    );
    expect(agent.calls).toHaveLength(0);
  });

  it.each([
    "queued",
    "accepted",
    "consumed",
  ] as const)("continues with a %s steered prompt linked to the interrupted turn", async (state) => {
    await interrupted();
    await repo.recordUserInput(
      "steered",
      "chat",
      JSON.stringify([{ type: "text", content: "Also run tests" }]),
    );
    await repo.updateUserInput("chat", {
      type: "input_status",
      inputId: "steered",
      turnId: "chat-turn",
      state,
    });
    const { agent, runner } = backend();
    await continueInterruptedTurns(await repo.endInterruptedTurns(DAY), repo, runner);
    expect(agent.calls).toHaveLength(1);
    expect(agent.calls[0]?.prompt).toContain("Finish the work\n\nAlso run tests");
  });

  it("quotes the guardian's chat line instead of the composed model prompt", async () => {
    await interrupted(
      "chat",
      `<workspace_context>${"context ".repeat(200)}</workspace_context>\nFinish the work`,
      "Fix the restart bug",
    );
    const { agent, runner } = backend();
    await continueInterruptedTurns(await repo.endInterruptedTurns(DAY), repo, runner);
    expect(agent.calls[0]?.prompt).toContain("Fix the restart bug");
    expect(agent.calls[0]?.prompt).not.toContain("<workspace_context>");
  });

  it("bounds the guardian excerpt to 1000 characters total", async () => {
    await interrupted("chat", "composed prompt", "a".repeat(700));
    await repo.recordUserInput(
      "steered",
      "chat",
      JSON.stringify([{ type: "text", content: "b".repeat(700) }]),
    );
    await repo.updateUserInput("chat", {
      type: "input_status",
      inputId: "steered",
      turnId: "chat-turn",
      state: "consumed",
    });
    const { agent, runner } = backend();
    await continueInterruptedTurns(await repo.endInterruptedTurns(DAY), repo, runner);
    expect(agent.calls[0]?.prompt).toBe(
      RESTART_CONTINUATION_PROMPT +
        "\n\nInterrupted request (may already be partly complete):\n" +
        "a".repeat(700) +
        "\n\n" +
        "b".repeat(298),
    );
  });

  it("reads only the turn's guardian prompt lines", async () => {
    await interrupted();
    await repo.recordUserInput(
      "automated",
      "chat",
      JSON.stringify([{ type: "text", content: "Automated input" }]),
      undefined,
      { platform: "webchat", id: "automated::1::app:example" },
    );
    await repo.updateUserInput("chat", {
      type: "input_status",
      inputId: "automated",
      turnId: "chat-turn",
      state: "consumed",
    });
    await repo.addSentMessage(
      "answer",
      "chat",
      [{ type: "text", content: "Agent answer" }],
      "chat-turn",
    );
    await repo.recordUserInput(
      "other-turn",
      "chat",
      JSON.stringify([{ type: "text", content: "Another request" }]),
    );
    await repo.updateUserInput("chat", {
      type: "input_status",
      inputId: "other-turn",
      turnId: "other-turn",
      state: "consumed",
    });
    const [turn] = await repo.endInterruptedTurns(DAY);
    expect(repo.getRestartGuardianPrompt(turn!)).toBe("Finish the work");
  });

  it("omits a missing guardian excerpt without falling back to the composed prompt", async () => {
    await interrupted("chat", "composed prompt must not be quoted");
    const turns = await repo.endInterruptedTurns(DAY);
    const { agent, runner } = backend();
    await continueInterruptedTurns(
      turns,
      {
        canContinueAfterRestart: (turn) => repo.canContinueAfterRestart(turn),
        getRestartGuardianPrompt: () => "",
        getRestartLastActivityAt: (turn) => repo.getRestartLastActivityAt(turn),
      },
      runner,
    );
    expect(agent.calls[0]?.prompt).toBe(RESTART_CONTINUATION_PROMPT);
    await db.db.run("DELETE FROM agent_turn_messages");
    expect(repo.getRestartGuardianPrompt(turns[0]!)).toBe("");
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
