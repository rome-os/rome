import { afterEach, beforeEach, describe, expect, it, rs } from "@rstest/core";
import {
  createModelAccounts,
  type ModelAccount,
  type ModelAccountReport,
  type ModelAccounts,
} from "../agent/index.js";
import { sessions } from "../db/schema.js";
import { createTestDb, type TestDb } from "../test/helpers.js";
import { ChatsWebChatRepository } from "../webchat/chats-webchat-repository.js";
import { startUsageLimitNotice } from "../webchat/usage-limit-continuation.js";

const HOUR = 60 * 60 * 1000;
/** How long after a stated limit end the account is read. */
const RESET_GRACE_MS = 2 * 60 * 1000;
const NOW = Date.parse("2026-11-10T12:00:00Z");

const available: ModelAccountReport = { state: "available", account: { loggedIn: true } };
const limitedUntil = (at: number): ModelAccountReport => ({
  state: "usage_limit_reached",
  usageLimitUntil: new Date(at).toISOString(),
  account: { loggedIn: true },
});

/** An account whose next answer the test sets. A slow one answers after a delay, as a real read does. */
function fakeAccount(initial: ModelAccountReport) {
  let answer = initial;
  let slow = false;
  let failing = false;
  const listeners = new Set<() => void>();
  const account: ModelAccount = {
    report: rs.fn(async () => {
      if (slow) await new Promise<void>((resolve) => setTimeout(resolve, 50));
      if (failing) throw new Error("down");
      return answer;
    }),
    onChanged(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    close() {},
  };
  return {
    account,
    set(next: ModelAccountReport) {
      answer = next;
    },
    /** The provider refused a turn: the account says it changed, and its read is still to come. */
    refused(next: ModelAccountReport) {
      answer = next;
      slow = true;
      for (const listener of listeners) listener();
    },
    /** Reads of the account fail, and keep the answer Rome last remembered. */
    failReads(on: boolean) {
      failing = on;
    },
    settleReads() {
      slow = false;
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

describe("usage-limit notice", () => {
  let db: TestDb;
  let repo: ChatsWebChatRepository;
  let accounts: ModelAccounts;
  let claude: ReturnType<typeof fakeAccount>;
  let codex: ReturnType<typeof fakeAccount>;
  let stop: (() => void) | undefined;
  let notify: ReturnType<typeof rs.fn<(text: string) => Promise<void>>>;

  beforeEach(() => {
    rs.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    rs.setSystemTime(NOW);
    db = createTestDb();
    repo = new ChatsWebChatRepository(db.db);
    notify = rs.fn(async () => {});
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
      /** The runtime session has not completed a turn, so it holds no model pin. */
      unpinned?: boolean;
      runtimeActiveAt?: Date;
      /** The chat's agent. */
      agent?: string;
      ownerKey?: string;
    } = {},
  ) {
    const { error = MID_RUN, pin = "anthropic", guardianPrompt = "Finish the work" } = options;
    const agent = options.agent ?? "assistant:coder";
    await repo.createSession(
      id,
      id,
      undefined,
      "default",
      null,
      "default",
      agent,
      "webchat",
      null,
      options.ownerKey ? { ownerKey: options.ownerKey } : {},
    );
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
    if (pin || options.unpinned) {
      await db.db.insert(sessions).values({
        id: `${id}-runtime`,
        agentName: agent,
        chatId: id,
        provider: options.unpinned ? null : pin,
        channelThreadKey: `webchat:${id}`,
        createdAt: new Date(),
        lastActiveAt: options.runtimeActiveAt ?? new Date(),
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

  function start() {
    stop = startUsageLimitNotice({ accounts, db: db.db, repo, notify });
  }

  /** Runs everything already scheduled, without moving the clock. */
  const settle = () => rs.advanceTimersByTimeAsync(0);

  async function clearAndSweep(provider: "anthropic" | "openai" = "anthropic") {
    await accounts.refresh(provider);
    await settle();
  }

  const noticeText = (call = 0) => (notify.mock.calls[call]?.[0] as string | undefined) ?? "";

  describe("a stopped turn", () => {
    it("is listed once the provider clears, in one notice that names the provider", async () => {
      await stopped();
      claude.set(limitedUntil(NOW + HOUR));
      await accounts.refresh("anthropic");
      start();
      await settle();
      expect(notify).not.toHaveBeenCalled();

      // An early clear arrives with the hourly read, long before the limit's stated end.
      claude.set(available);
      await clearAndSweep();

      expect(notify).toHaveBeenCalledTimes(1);
      const text = noticeText();
      expect(text).toContain("<restart_recovery>");
      expect(text).toContain(
        "Model usage on anthropic is available again; these chats stopped on its limit:",
      );
      expect(text).toContain('guardian chat "chat" · assistant:coder · id chat');
      expect(text).not.toContain("nothing was done");
    });

    it("says a turn the limit refused before it started did nothing", async () => {
      await stopped("chat", { error: REFUSED, refusedByDashboard: true });
      start();
      await clearAndSweep();
      expect(notify).toHaveBeenCalledTimes(1);
      expect(noticeText()).toContain("nothing was done");
    });

    it("recognizes an older mid-run error that has only the provider's wording", async () => {
      await stopped("chat", { error: SESSION_LIMIT });
      start();
      await clearAndSweep();
      expect(notify).toHaveBeenCalledTimes(1);
    });

    it("lists only turns on the provider that cleared, in one notice for all of them", async () => {
      await stopped("claude-chat", { pin: "anthropic" });
      await stopped("claude-chat-2", { pin: "anthropic" });
      await stopped("codex-chat", {
        pin: "openai",
        error: { error: "limit", code: "usage_limit" },
      });
      await stopped("unpinned-chat", { pin: null });
      start();
      await clearAndSweep("anthropic");
      expect(notify).toHaveBeenCalledTimes(1);
      const text = noticeText();
      expect(text).toContain("id claude-chat ");
      expect(text).toContain("id claude-chat-2 ");
      expect(text).not.toContain("codex-chat");
      expect(text).not.toContain("unpinned-chat");
      await clearAndSweep("openai");
      expect(notify).toHaveBeenCalledTimes(2);
      expect(noticeText(1)).toContain("Model usage on openai");
      expect(noticeText(1)).toContain("id codex-chat ");
    });

    it("leaves a refusal on another provider than the chat's pin out", async () => {
      await stopped("chat", { error: REFUSED, pin: "openai" });
      start();
      await clearAndSweep("anthropic");
      await clearAndSweep("openai");
      expect(notify).not.toHaveBeenCalled();
    });

    it.each([
      ["not signed in", { ...REFUSED, error: "Claude is not signed in", reason: "not_logged_in" }],
      ["revoked credentials", { error: "Failed to authenticate", code: "auth_revoked" }],
      ["a monthly spend limit", { error: "You have hit your monthly spend limit" }],
      ["used-up credits", { error: "Rome credits are used up", code: "credits_used_up" }],
      ["an ambiguous limit", { error: "You've hit your limit" }],
      ["a transient failure", { error: "overloaded", code: "transient" }],
      ["a restart", { error: "Rome restarted while this was running. The task did not finish." }],
    ])("leaves a turn stopped by %s out", async (_label, error) => {
      await stopped("chat", { error });
      start();
      await clearAndSweep("anthropic");
      expect(notify).not.toHaveBeenCalled();
    });

    it("leaves a turn that is still running out", async () => {
      await stopped("running", { running: true });
      start();
      await clearAndSweep();
      expect(notify).not.toHaveBeenCalled();
    });

    it("leaves a visitor's turn and a turn idle for a day out", async () => {
      await stopped("visitor", { ownerKey: "visitor:someone" });
      rs.setSystemTime(NOW - 30 * HOUR);
      await stopped("idle", { runtimeActiveAt: new Date(NOW - 26 * HOUR) });
      rs.setSystemTime(NOW);
      start();
      await clearAndSweep();
      expect(notify).not.toHaveBeenCalled();
    });

    it("does not list a notice turn a limit stopped", async () => {
      await stopped("chat", { guardianPrompt: "<restart_recovery>…" });
      start();
      await clearAndSweep();
      expect(notify).not.toHaveBeenCalled();
    });
  });

  describe("when the limit ends", () => {
    it("notifies once the read after the stated end reports available", async () => {
      await stopped();
      claude.set(limitedUntil(NOW + 5 * HOUR));
      await accounts.refresh("anthropic");
      start();

      claude.set(available);
      await rs.advanceTimersByTimeAsync(5 * HOUR + RESET_GRACE_MS - 1);
      expect(notify).not.toHaveBeenCalled();
      await rs.advanceTimersByTimeAsync(1);
      expect(notify).toHaveBeenCalledTimes(1);
    });

    it("notifies at start for a limit that ended while Rome was down", async () => {
      await stopped();
      claude.set(limitedUntil(NOW - HOUR));
      await accounts.refresh("anthropic");
      start();
      await settle();
      expect(notify).toHaveBeenCalledTimes(1);
    });

    it("notifies after the first read of boot when it settles after start", async () => {
      await stopped();
      start();
      await settle();
      expect(notify).not.toHaveBeenCalled();
      await accounts.refresh();
      await settle();
      expect(notify).toHaveBeenCalledTimes(1);
    });

    it("does not notify while the provider is still limited, or after a read that failed", async () => {
      await stopped();
      claude.set(limitedUntil(NOW + HOUR));
      start();
      await clearAndSweep();
      expect(notify).not.toHaveBeenCalled();
      claude.set(available);
      claude.failReads(true);
      await clearAndSweep();
      expect(notify).not.toHaveBeenCalled();
    });
  });

  describe("bounds", () => {
    it("lists each stopped turn once however often the account is read", async () => {
      await stopped();
      start();
      await clearAndSweep();
      await clearAndSweep();
      await clearAndSweep();
      expect(notify).toHaveBeenCalledTimes(1);
    });

    it("sends one notice per reset: a later reset lists only turns stopped since", async () => {
      await stopped("first");
      start();
      await clearAndSweep();
      expect(notify).toHaveBeenCalledTimes(1);
      claude.set(limitedUntil(NOW + HOUR));
      await clearAndSweep();
      await stopped("second");
      claude.set(available);
      await clearAndSweep();
      expect(notify).toHaveBeenCalledTimes(2);
      expect(noticeText(1)).toContain("id second ");
      expect(noticeText(1)).not.toContain("id first ");
    });

    it("never fails a read because the notice could not be sent", async () => {
      notify.mockImplementation(async () => {
        throw new Error("no chat");
      });
      await stopped();
      start();
      await clearAndSweep();
      expect(notify).toHaveBeenCalledTimes(1);
      await clearAndSweep();
      expect(notify).toHaveBeenCalledTimes(1);
    });

    it("ignores later reads once stopped", async () => {
      await stopped();
      start();
      stop?.();
      await clearAndSweep();
      expect(notify).not.toHaveBeenCalled();
    });
  });
});
