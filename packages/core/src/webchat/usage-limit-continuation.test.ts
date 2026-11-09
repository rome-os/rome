import { afterEach, beforeEach, describe, expect, it, rs } from "@rstest/core";
import { eq } from "drizzle-orm";
import {
  createModelAccounts,
  type ModelAccount,
  type ModelAccountReport,
  type ModelAccounts,
} from "../agent/index.js";
import {
  createBackendTurnRunner,
  type MainBackendTurnRunner,
} from "../apps/actions/backend-turn.js";
import type { Channel } from "../chats/connected-accounts/connected-account.js";
import { romeSessions, sessions } from "../db/schema.js";
import { createMockAgentRunner, createTestDb, type TestDb } from "../test/helpers.js";
import { ChatsWebChatRepository } from "./chats-webchat-repository.js";
import { continueInterruptedTurns } from "./restart-continuation.js";
import {
  startUsageLimitContinuation,
  usageLimitContinuationPrompt,
} from "./usage-limit-continuation.js";

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const NOW = Date.parse("2026-11-10T12:00:00Z");
const MAX_TIMER_MS = 2 ** 31 - 1;

const available: ModelAccountReport = { state: "available", account: { loggedIn: true } };
const limitedUntil = (at: number): ModelAccountReport => ({
  state: "usage_limit_reached",
  usageLimitUntil: new Date(at).toISOString(),
  account: { loggedIn: true },
});

/** An account whose next answer the test sets. */
function fakeAccount(initial: ModelAccountReport) {
  let answer = initial;
  const account: ModelAccount = {
    report: rs.fn(async () => answer),
    onChanged: () => () => {},
    close() {},
  };
  return {
    account,
    set(next: ModelAccountReport) {
      answer = next;
    },
    reads: () => (account.report as ReturnType<typeof rs.fn>).mock.calls.length,
  };
}

const SESSION_LIMIT = { error: "You've hit your session limit · resets 3pm (UTC)" };
const MID_RUN = { ...SESSION_LIMIT, code: "usage_limit" };
const REFUSED = {
  error: "Selected model provider is unavailable: Claude has reached its usage limit",
  code: "model_provider_unavailable",
  provider: "anthropic",
  reason: "quota_exhausted",
};

describe("usage-limit continuation", () => {
  let db: TestDb;
  let repo: ChatsWebChatRepository;
  let accounts: ModelAccounts;
  let claude: ReturnType<typeof fakeAccount>;
  let codex: ReturnType<typeof fakeAccount>;
  let stop: (() => void) | undefined;

  beforeEach(() => {
    rs.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    rs.setSystemTime(NOW);
    db = createTestDb();
    repo = new ChatsWebChatRepository(db.db);
    claude = fakeAccount(available);
    codex = fakeAccount(available);
    accounts = createModelAccounts({
      accounts: { anthropic: claude.account, openai: codex.account },
      startRefresh: false,
      refreshIntervalMs: null,
      now: () => new Date(Date.now()),
    });
  });
  afterEach(() => {
    stop?.();
    stop = undefined;
    accounts.close();
    rs.useRealTimers();
    db.close();
  });

  /** A top-level chat whose newest turn ended in the given error block. */
  async function stopped(
    id = "chat",
    options: {
      error?: Record<string, unknown>;
      pin?: string | null;
      guardianPrompt?: string;
      running?: boolean;
      /** The dashboard refused the turn before any model session opened, so `turn_start` names the chat. */
      refusedByDashboard?: boolean;
      runtimeStatus?: "active" | "completed";
    } = {},
  ) {
    const { error = MID_RUN, pin = "anthropic", guardianPrompt = "Finish the work" } = options;
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
    if (pin) {
      await db.db.insert(sessions).values({
        id: `${id}-runtime`,
        agentName: "assistant:coder",
        chatId: id,
        provider: pin,
        channelThreadKey: `webchat:${id}`,
        createdAt: new Date(),
        lastActiveAt: new Date(),
        status: options.runtimeStatus ?? "active",
      });
    }
    await repo.appendTraceBlocks({
      messageId: `${id}-trace`,
      sessionId: id,
      turnId: `${id}-turn`,
      startSeq: 0,
      blocks: [
        {
          type: "turn_start",
          turnId: `${id}-turn`,
          sessionId: options.refusedByDashboard ? id : `${id}-runtime`,
          userPrompt: `composed ${guardianPrompt}`,
        },
        ...(options.running
          ? []
          : [
              { type: "error", ...error },
              { type: "turn_end", turnId: `${id}-turn`, status: "error", durationMs: 1 },
            ]),
      ] as never,
    });
  }

  function backend(options: { beforeQueuedTask?: () => Promise<void> } = {}) {
    const agent = createMockAgentRunner([]);
    const send = rs.fn(async () => ({ messageId: "reply", chatId: "chat" }));
    const runner = createBackendTurnRunner({
      agentRunner: agent,
      channel: () => ({ send: { send } }) as unknown as Channel,
    });
    runner.setWebchatRuntime({
      enqueueSessionTask: async (_id, task) => {
        await options.beforeQueuedTask?.();
        await task({ emit: async () => {} });
      },
    });
    return { agent, runner };
  }

  function start(runner: Pick<MainBackendTurnRunner, "runAndReport">) {
    stop = startUsageLimitContinuation({ accounts, repo, runner });
    return stop;
  }

  /** Runs everything already scheduled, without moving the clock. */
  const settle = () => rs.advanceTimersByTimeAsync(0);

  async function clearAndSweep(provider: "anthropic" | "openai" = "anthropic") {
    await accounts.refresh(provider);
    await settle();
  }

  describe("a stopped turn", () => {
    it("continues after the provider clears, in the same chat, runtime and agent", async () => {
      await stopped();
      claude.set(limitedUntil(NOW + HOUR));
      await accounts.refresh("anthropic");
      const { agent, runner } = backend();
      start(runner);
      await settle();
      expect(agent.calls).toHaveLength(0);

      // An early clear arrives with the hourly read, long before the limit's stated end.
      claude.set(available);
      await clearAndSweep();

      expect(agent.calls).toHaveLength(1);
      expect(agent.calls[0]).toMatchObject({
        agentName: "assistant:coder",
        sessionId: "chat-runtime",
        initiatedBy: "system",
        inputLabel: "Usage limit recovery",
        threadContext: { channel: "webchat", threadId: "chat" },
      });
      const prompt = agent.calls[0]?.prompt ?? "";
      expect(prompt).toContain("<usage_limit_recovery>");
      expect(prompt).toContain("Do only what remains");
      expect(prompt).toContain("ask the guardian rather than redo it");
      expect(prompt).toContain(
        "Stopped request (may already be partly complete):\nFinish the work",
      );
      expect(prompt).not.toContain("composed");
      expect(prompt).not.toContain("none of it was done");
    });

    it("continues a turn the limit refused before it started, and says it never ran", async () => {
      await stopped("chat", {
        error: REFUSED,
        guardianPrompt: "a".repeat(1500),
        refusedByDashboard: true,
      });
      const { agent, runner } = backend();
      start(runner);
      await clearAndSweep();
      expect(agent.calls).toHaveLength(1);
      // `turn_start` names the chat, so the runtime to resume is the chat's own.
      expect(agent.calls[0]?.sessionId).toBe("chat-runtime");
      const prompt = agent.calls[0]?.prompt ?? "";
      expect(prompt).toContain("refused before it reached a model, so none of it was done");
      expect(prompt).toContain("Treat it as the request to act on");
      expect(prompt).toContain("cut at 1000 characters, so read the chat for its full text");
      expect(prompt).toContain(`Refused request:\n${"a".repeat(1000)}`);
      expect(prompt).not.toContain("a".repeat(1001));
    });

    it("continues a refusal that the session's own turn recorded, in that runtime", async () => {
      await stopped("chat", { error: REFUSED });
      const { agent, runner } = backend();
      start(runner);
      await clearAndSweep();
      expect(agent.calls.map((call) => call.sessionId)).toEqual(["chat-runtime"]);
    });

    it.each([
      ["has no runtime session", { pin: null }],
      ["has only a runtime session that is no longer active", { runtimeStatus: "completed" }],
    ] as const)("leaves a stopped chat that %s, which cannot be resumed", async (_label, options) => {
      await stopped("chat", { error: REFUSED, refusedByDashboard: true, ...options });
      const { agent, runner } = backend();
      start(runner);
      await clearAndSweep();
      expect(agent.calls).toHaveLength(0);
    });

    it("takes the provider from the chat's model pin when every provider was limited", async () => {
      const error = {
        error: "All connected model providers have reached their usage limits",
        code: "no_model_provider_available",
        reason: "quota_exhausted",
      };
      await stopped("claude-chat", { error, pin: "anthropic", refusedByDashboard: true });
      await stopped("codex-chat", { error, pin: "openai", refusedByDashboard: true });
      const { agent, runner } = backend();
      start(runner);
      await clearAndSweep("openai");
      expect(agent.calls.map((call) => call.threadContext?.threadId)).toEqual(["codex-chat"]);
      await clearAndSweep("anthropic");
      expect(agent.calls.map((call) => call.threadContext?.threadId)).toEqual([
        "codex-chat",
        "claude-chat",
      ]);
    });

    it("recognizes an older mid-run error that has only the provider's wording", async () => {
      await stopped("chat", { error: SESSION_LIMIT });
      const { agent, runner } = backend();
      start(runner);
      await clearAndSweep();
      expect(agent.calls).toHaveLength(1);
    });

    it("continues only chats on the provider that cleared", async () => {
      await stopped("claude-chat", { pin: "anthropic" });
      await stopped("codex-chat", {
        pin: "openai",
        error: { error: "limit", code: "usage_limit" },
      });
      await stopped("unpinned-chat", { pin: null });
      const { agent, runner } = backend();
      start(runner);
      await clearAndSweep("anthropic");
      expect(agent.calls.map((call) => call.threadContext?.threadId)).toEqual(["claude-chat"]);
    });

    it("trusts the provider an error names over the chat's pin", async () => {
      await stopped("chat", { error: REFUSED, pin: "openai" });
      const { agent, runner } = backend();
      start(runner);
      await clearAndSweep("openai");
      expect(agent.calls).toHaveLength(0);
      await clearAndSweep("anthropic");
      expect(agent.calls).toHaveLength(1);
    });

    it.each([
      ["not signed in", { ...REFUSED, error: "Claude is not signed in", reason: "not_logged_in" }],
      ["revoked credentials", { error: "Failed to authenticate", code: "auth_revoked" }],
      ["a monthly spend limit", { error: "You have hit your monthly spend limit" }],
      ["used-up credits", { error: "Rome credits are used up", code: "credits_used_up" }],
      ["an ambiguous limit", { error: "You've hit your limit" }],
      ["a transient failure", { error: "overloaded", code: "transient" }],
      ["a single-model limit", { error: "Opus limit reached for this plan" }],
      ["a restart", { error: "Rome restarted while this was running. The task did not finish." }],
      ["a plain error", { error: "something broke" }],
    ])("leaves a turn stopped by %s alone", async (_label, error) => {
      await stopped("chat", { error });
      const { agent, runner } = backend();
      start(runner);
      await clearAndSweep("anthropic");
      expect(agent.calls).toHaveLength(0);
    });

    it("leaves a turn that is still running, or ended without an error, alone", async () => {
      await stopped("running", { running: true });
      const { agent, runner } = backend();
      start(runner);
      await clearAndSweep();
      expect(agent.calls).toHaveLength(0);
    });

    it("does not sweep while the provider is still limited", async () => {
      await stopped();
      claude.set(limitedUntil(NOW + HOUR));
      const { agent, runner } = backend();
      start(runner);
      await clearAndSweep();
      expect(agent.calls).toHaveLength(0);
    });
  });

  describe("when the limit ends", () => {
    it("reads the account at the stated end, and continues once it reports available", async () => {
      await stopped();
      claude.set(limitedUntil(NOW + 5 * HOUR));
      await accounts.refresh("anthropic");
      const { agent, runner } = backend();
      start(runner);
      const reads = claude.reads();

      await rs.advanceTimersByTimeAsync(5 * HOUR - 1);
      expect(claude.reads()).toBe(reads);
      claude.set(available);
      await rs.advanceTimersByTimeAsync(1);

      expect(claude.reads()).toBe(reads + 1);
      expect(agent.calls).toHaveLength(1);
    });

    it("arms again when a read moves the end, and not for the old time", async () => {
      claude.set(limitedUntil(NOW + HOUR));
      await accounts.refresh("anthropic");
      const { runner } = backend();
      start(runner);
      expect(rs.getTimerCount()).toBe(1);
      claude.set(limitedUntil(NOW + 3 * HOUR));
      await accounts.refresh("anthropic");
      expect(rs.getTimerCount()).toBe(1);

      const reads = claude.reads();
      await rs.advanceTimersByTimeAsync(HOUR);
      expect(claude.reads()).toBe(reads);
      await rs.advanceTimersByTimeAsync(2 * HOUR);
      expect(claude.reads()).toBe(reads + 1);
    });

    it("arms nothing for a provider that is available, and drops a timer once it clears", async () => {
      claude.set(limitedUntil(NOW + HOUR));
      await accounts.refresh("anthropic");
      const { runner } = backend();
      start(runner);
      expect(rs.getTimerCount()).toBe(1);
      claude.set(available);
      await accounts.refresh("anthropic");
      expect(rs.getTimerCount()).toBe(0);
    });

    it("reaches an end more than 24.8 days away in steps, without firing at once", async () => {
      const end = NOW + 40 * DAY;
      claude.set(limitedUntil(end));
      await accounts.refresh("anthropic");
      await stopped();
      const { agent, runner } = backend();
      start(runner);
      const reads = claude.reads();

      await rs.advanceTimersByTimeAsync(MAX_TIMER_MS - 1);
      expect(claude.reads()).toBe(reads);
      await rs.advanceTimersByTimeAsync(1);
      // The early step reads the account, which is still limited, and arms the rest.
      expect(claude.reads()).toBe(reads + 1);
      expect(rs.getTimerCount()).toBe(1);
      expect(agent.calls).toHaveLength(0);

      claude.set(available);
      await rs.advanceTimersByTimeAsync(end - Date.now());
      expect(claude.reads()).toBe(reads + 2);
    });

    it("sweeps at start for a limit that ended while Rome was down", async () => {
      await stopped();
      claude.set(limitedUntil(NOW - HOUR));
      await accounts.refresh("anthropic");
      const { agent, runner } = backend();
      start(runner);
      await settle();
      expect(agent.calls).toHaveLength(1);
    });

    it("sweeps after the first read of boot when it settles after start", async () => {
      await stopped();
      const { agent, runner } = backend();
      start(runner);
      await settle();
      expect(agent.calls).toHaveLength(0);
      await accounts.refresh();
      await settle();
      expect(agent.calls).toHaveLength(1);
    });
  });

  describe("eligibility", () => {
    it("never continues a chat the guardian has written in since", async () => {
      await stopped();
      await repo.recordUserInput("newer", "chat", "[]");
      const { agent, runner } = backend();
      start(runner);
      await clearAndSweep();
      expect(agent.calls).toHaveLength(0);
    });

    it("rechecks in the chat's queue, where a newer message may have arrived", async () => {
      await stopped();
      const { agent, runner } = backend({
        beforeQueuedTask: async () => {
          await repo.recordUserInput("newer", "chat", "[]");
        },
      });
      start(runner);
      await clearAndSweep();
      expect(agent.calls).toHaveLength(0);
    });

    it("continues only the chat's newest turn", async () => {
      await stopped();
      await repo.appendTraceBlocks({
        messageId: "chat-newer-trace",
        sessionId: "chat",
        turnId: "newer",
        startSeq: 0,
        blocks: [
          { type: "turn_start", turnId: "newer", sessionId: "chat-runtime" },
          { type: "turn_end", turnId: "newer", status: "completed", durationMs: 1 },
        ],
      });
      const { agent, runner } = backend();
      start(runner);
      await clearAndSweep();
      expect(agent.calls).toHaveLength(0);
    });

    it("continues the newest of two stopped turns, quoting its request", async () => {
      await stopped("chat", { guardianPrompt: "First request" });
      rs.setSystemTime(NOW + 1000);
      await repo.recordUserInput(
        "second-input",
        "chat",
        JSON.stringify([{ type: "text", content: "Second request" }]),
      );
      await repo.updateUserInput("chat", {
        type: "input_status",
        inputId: "second-input",
        turnId: "second-turn",
        state: "consumed",
      });
      await repo.appendTraceBlocks({
        messageId: "chat-second-trace",
        sessionId: "chat",
        turnId: "second-turn",
        startSeq: 0,
        blocks: [
          {
            type: "turn_start",
            turnId: "second-turn",
            sessionId: "chat-runtime",
            userPrompt: "Second request",
          },
          { type: "error", ...MID_RUN },
          { type: "turn_end", turnId: "second-turn", status: "error", durationMs: 1 },
        ] as never,
      });
      const { agent, runner } = backend();
      start(runner);
      await clearAndSweep();
      expect(agent.calls).toHaveLength(1);
      expect(agent.calls[0]?.prompt).toContain("Second request");
      expect(agent.calls[0]?.prompt).not.toContain("First request");
    });

    it.each([
      // Stored times are whole seconds.
      [DAY - 2000, 1],
      [DAY, 0],
      [30 * HOUR, 0],
    ])("with the stop %i ms old, runs %i continuation(s)", async (age, expected) => {
      rs.setSystemTime(NOW - age);
      await stopped();
      rs.setSystemTime(NOW);
      const { agent, runner } = backend();
      start(runner);
      await clearAndSweep();
      expect(agent.calls).toHaveLength(expected);
    });

    it("continues a system-started turn's chat only through a guardian prompt", async () => {
      await stopped();
      await db.db.run("DELETE FROM agent_turn_messages");
      const { agent, runner } = backend();
      start(runner);
      await clearAndSweep();
      expect(agent.calls).toHaveLength(0);
    });

    it("continues the control chat, so each exclusion below is the change's doing", async () => {
      await stopped();
      const { agent, runner } = backend();
      start(runner);
      await clearAndSweep();
      expect(agent.calls).toHaveLength(1);
    });

    it.each([
      { type: "routine" },
      { type: "subagent" },
      { type: "handoff" },
      { type: "channel", chatPlatform: "telegram" },
      { parentSessionId: "parent" },
      { ownerKey: "visitor:someone" },
      { triggerKind: "routine" },
      { triggerKind: "concierge" },
      { agentName: "core:concierge" },
      { agentName: "concierge" },
      { archivedAt: new Date() },
      { chatId: null },
    ])("leaves an out-of-scope chat stopped: %j", async (change) => {
      await stopped();
      await db.db.update(romeSessions).set(change).where(eq(romeSessions.id, "chat"));
      const { agent, runner } = backend();
      start(runner);
      await clearAndSweep();
      expect(agent.calls).toHaveLength(0);
    });

    it("leaves the Concierge main chat to its own recovery", async () => {
      await stopped("concierge");
      const { agent, runner } = backend();
      start(runner);
      await clearAndSweep();
      expect(agent.calls).toHaveLength(0);
    });
  });

  describe("bounds", () => {
    it("continues each stop once however often the account is read", async () => {
      await stopped();
      const { agent, runner } = backend();
      start(runner);
      await clearAndSweep();
      await clearAndSweep();
      await clearAndSweep();
      expect(agent.calls).toHaveLength(1);
    });

    it("never continues a recovery turn, even through a new process", async () => {
      await stopped();
      const { agent, runner } = backend();
      start(runner);
      await clearAndSweep();
      const recovery = agent.calls[0]!;
      // The recovery turn hit the limit again: its trace is the chat's newest.
      rs.setSystemTime(NOW + 1000);
      await repo.appendTraceBlocks({
        messageId: "chat-recovery-trace",
        sessionId: "chat",
        turnId: "recovery-turn",
        startSeq: 0,
        blocks: [
          {
            type: "turn_start",
            turnId: "recovery-turn",
            sessionId: "chat-runtime",
            userPrompt: recovery.prompt,
          },
          { type: "error", ...MID_RUN },
          { type: "turn_end", turnId: "recovery-turn", status: "error", durationMs: 1 },
        ] as never,
      });
      stop?.();
      const next = backend();
      start(next.runner);
      await clearAndSweep();
      expect(next.agent.calls).toHaveLength(0);
    });

    it("never continues a turn whose own prompt carries the marker", async () => {
      await stopped();
      await db.db.run(
        "UPDATE rome_agent_trace_blocks SET content = json_set(content, '$.userPrompt', '<usage_limit_recovery>x') WHERE json_extract(content, '$.type') = 'turn_start'",
      );
      const { agent, runner } = backend();
      start(runner);
      await clearAndSweep();
      expect(agent.calls).toHaveLength(0);
    });

    it("leaves a continuation a restart cut off to the restart notice", async () => {
      await stopped();
      const { agent, runner } = backend();
      start(runner);
      await clearAndSweep();
      stop?.();
      rs.setSystemTime(NOW + 1000);
      await repo.appendTraceBlocks({
        messageId: "chat-recovery-trace",
        sessionId: "chat",
        turnId: "recovery-turn",
        startSeq: 0,
        blocks: [
          {
            type: "turn_start",
            turnId: "recovery-turn",
            sessionId: "chat-runtime",
            userPrompt: agent.calls[0]!.prompt,
          },
        ],
      });
      const cutOff = await repo.endInterruptedTurns(DAY);
      expect(cutOff.map((turn) => turn.turnId)).toEqual(["recovery-turn"]);
      const restart = backend();
      await continueInterruptedTurns(cutOff, repo, restart.runner);
      expect(restart.agent.calls).toHaveLength(0);
    });

    it("runs one chat at a time and a request during a sweep never starts a duplicate", async () => {
      await stopped("one");
      await stopped("two");
      let active = 0;
      let maxActive = 0;
      const release: Array<() => void> = [];
      const runAndReport = rs.fn(async () => {
        active++;
        maxActive = Math.max(maxActive, active);
        await new Promise<void>((resolve) => release.push(resolve));
        active--;
        return "completed" as const;
      });
      start({ runAndReport });
      await clearAndSweep();
      expect(runAndReport).toHaveBeenCalledTimes(1);
      // Reads that settle mid-sweep, for either provider.
      await clearAndSweep();
      await clearAndSweep("openai");
      expect(runAndReport).toHaveBeenCalledTimes(1);

      release.shift()?.();
      await settle();
      expect(runAndReport).toHaveBeenCalledTimes(2);
      release.shift()?.();
      await settle();
      await clearAndSweep();
      expect(runAndReport).toHaveBeenCalledTimes(2);
      expect(maxActive).toBe(1);
    });

    it("stops the sweep when the provider is limited again, and goes on at the next reset", async () => {
      await stopped("one");
      rs.setSystemTime(NOW + 1000);
      await stopped("two");
      const calls: string[] = [];
      const runAndReport = rs.fn(async (params: { threadId: string }) => {
        calls.push(params.threadId);
        claude.set(limitedUntil(NOW + 6 * HOUR));
        await accounts.refresh("anthropic");
        return "failed" as const;
      });
      start({ runAndReport });
      await clearAndSweep();
      expect(calls).toEqual(["one"]);

      claude.set(available);
      await rs.advanceTimersByTimeAsync(6 * HOUR);
      expect(calls).toEqual(["one", "two"]);
    });

    it("tries a continuation again at the next reset when it was dropped, not run", async () => {
      await stopped();
      let limitedOnce = false;
      const { agent, runner } = backend({
        beforeQueuedTask: async () => {
          if (limitedOnce) return;
          limitedOnce = true;
          // The chat's queue was long, and the provider is limited again by its turn.
          claude.set(limitedUntil(NOW + 2 * HOUR));
          await accounts.refresh("anthropic");
        },
      });
      start(runner);
      await clearAndSweep();
      expect(agent.calls).toHaveLength(0);

      claude.set(available);
      await rs.advanceTimersByTimeAsync(2 * HOUR);
      expect(agent.calls).toHaveLength(1);
    });

    it("does not retry a continuation whose dispatch failed", async () => {
      await stopped();
      const runAndReport = rs.fn(async () => {
        throw new Error("dispatch failed");
      });
      start({ runAndReport });
      await clearAndSweep();
      await clearAndSweep();
      expect(runAndReport).toHaveBeenCalledTimes(1);
    });
  });

  describe("shutdown", () => {
    it("clears its timers and ignores later reads", async () => {
      await stopped();
      claude.set(limitedUntil(NOW + HOUR));
      await accounts.refresh("anthropic");
      const { agent, runner } = backend();
      const stopIt = start(runner);
      expect(rs.getTimerCount()).toBe(1);
      stopIt();
      expect(rs.getTimerCount()).toBe(0);

      claude.set(available);
      await clearAndSweep();
      await rs.advanceTimersByTimeAsync(2 * HOUR);
      expect(agent.calls).toHaveLength(0);
    });
  });

  it("words a continuation with no known request without an excerpt", () => {
    expect(usageLimitContinuationPrompt("", false)).not.toContain("request (may");
    expect(usageLimitContinuationPrompt("", false).endsWith("</usage_limit_recovery>")).toBe(true);
  });
});
