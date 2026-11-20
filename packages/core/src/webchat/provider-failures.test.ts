import { describe, expect, it } from "@rstest/core";
import type { AgentTurnFailure } from "@rome-os/app-runtime";
import type { ProviderFailurePart, ProviderOutagePart } from "@rome/api-types/chat";
import type {
  DefaultProvider,
  DefaultProviderChange,
  ModelAccountReports,
  ProviderId,
} from "../agent/index.js";
import { reportOf } from "../test/kit/model-accounts.js";
import {
  createProviderFailures,
  outagePushText,
  PROVIDER_CARDS_SETTING_KEY,
  PROVIDER_OUTAGES_SETTING_KEY,
  PROVIDER_RESUMES_SETTING_KEY,
  type ProviderFailures,
  type ProviderFailuresDeps,
} from "./provider-failures.js";

type Row = {
  largeModelSelection?: string | null;
  largeModelSelectionBy?: "owner" | "auto" | "kept" | null;
  romeCredits?: boolean;
  triggerKind?: string | null;
  agentName?: string | null;
  ownerKey?: string | null;
};

const flush = async () => {
  for (let i = 0; i < 5; i++) await new Promise((resolve) => setTimeout(resolve, 0));
};

/**
 * The card module over fakes: the accounts and the default the guardian
 * has, the chats, the messages written, the turns run and the pushes sent.
 * Every provider error is injected as the failure the runtime reports.
 */
function harness(
  chats: Record<string, Row>,
  reports: ModelAccountReports,
  options: {
    defaultProvider?: DefaultProvider;
    signedIn?: { anthropic: boolean; openai: boolean; rome_credits: boolean };
    credits?: boolean;
    swap?: boolean;
    outcome?: "completed" | "failed";
    /** The stored settings, shared with an earlier harness as a restart would. */
    settings?: Map<string, unknown>;
    /** What a run does while it runs, as a turn's own events would. */
    onRun?: (params: { threadId: string }, failures: ProviderFailures) => Promise<void> | void;
    /** The silent retry's wait. Default: none. */
    delay?: () => Promise<void>;
    /** What the chat's session is opened by, as the real lookup would. */
    runtimeOf?: (chatId: string) => Promise<string | null>;
    /** What keeping a chat waits on, as the real write would. */
    keeping?: Promise<void>;
    /** Whether a stopped turn may still run again by itself. Default: always. */
    continues?: (chatId: string) => boolean;
  } = {},
) {
  const messages = new Map<string, { chatId: string; parts: unknown[] }>();
  const settings = options.settings ?? new Map<string, unknown>();
  const runs: Array<{ threadId: string; prompt: string; actor?: unknown }> = [];
  const pushes: string[] = [];
  const swaps: string[] = [];
  const kept: Array<{ chatId: string; provider: string }> = [];
  const followed: string[] = [];
  const chose: Array<{ provider: string; moveExisting?: boolean }> = [];
  const selected: Array<{ chatId: string; selection: string | null; credits?: boolean }> = [];
  const timers: Array<{ ms: number; work: () => void }> = [];
  const accountListeners = new Set<
    (provider: ProviderId, change: "authorization" | "refreshed") => void
  >();
  const defaultListeners = new Set<(change: DefaultProviderChange) => void>();
  let defaultProvider: DefaultProvider = options.defaultProvider ?? "anthropic";
  const signedIn = options.signedIn ?? { anthropic: true, openai: true, rome_credits: false };
  const deps: ProviderFailuresDeps = {
    accounts: {
      read: () => reports,
      onChanged: (listener) => {
        accountListeners.add(listener);
        return () => accountListeners.delete(listener);
      },
    },
    defaults: {
      current: () => defaultProvider,
      signedIn: () => signedIn,
      choose: async (provider, choice) => {
        chose.push({ provider, ...(choice ? { moveExisting: choice.moveExisting } : {}) });
        const from = defaultProvider;
        defaultProvider = provider;
        for (const listener of defaultListeners)
          listener({
            from,
            to: provider,
            by: "guardian",
            moveExisting: choice?.moveExisting ?? true,
          });
      },
      onChanged: (listener) => {
        defaultListeners.add(listener);
        return () => defaultListeners.delete(listener);
      },
    },
    chats: {
      keep: async (chatId, provider) => {
        await options.keeping;
        kept.push({ chatId, provider });
        if (provider === "rome_credits" && chats[chatId]) chats[chatId].romeCredits = true;
        return "claude-opus-5-5";
      },
      follow: async (chatId) => {
        followed.push(chatId);
      },
    },
    webchatRepo: {
      getSession: async (id: string) =>
        chats[id]
          ? {
              id,
              largeModelSelection: null,
              largeModelSelectionBy: null,
              triggerKind: null,
              agentName: null,
              romeCredits: false,
              ...chats[id],
            }
          : null,
      addBackendMessage: async (chatId: string, _turnId: string, parts: unknown[]) => {
        const id = `m${messages.size}`;
        messages.set(id, { chatId, parts });
        return { id };
      },
      // As the repository does: a message not written yet is left alone.
      updateMessageContent: async (id: string, content: string) => {
        const message = messages.get(id);
        if (!message) return false;
        messages.set(id, { chatId: message.chatId, parts: JSON.parse(content) });
        return true;
      },
      updateSessionRomeCredits: async (id: string, romeCredits: boolean) => {
        if (chats[id]) chats[id].romeCredits = romeCredits;
      },
      updateSessionLargeModelSelection: async (
        id: string,
        selection: string | null,
        by: "owner" | "auto" | "kept",
      ) => {
        if (chats[id]) {
          chats[id].largeModelSelection = selection;
          chats[id].largeModelSelectionBy = by;
        }
      },
    } as never,
    settings: {
      get: async (key: string) => (settings.get(key) ?? null) as never,
      set: async (key: string, value: unknown) => {
        settings.set(key, structuredClone(value));
      },
    },
    mainChatId: async (owner) => (owner === "guardian" ? "main" : `main-${owner}`),
    runtimeOf: options.runtimeOf ?? (async (chatId) => `session-${chatId}`),
    runner: {
      runAndReport: async (params, runOptions) => {
        runs.push({
          threadId: params.threadId,
          prompt: params.prompt,
          ...(runOptions?.actor ? { actor: runOptions.actor } : {}),
        });
        await options.onRun?.(params, failures);
        return options.outcome ?? "completed";
      },
    },
    swapModel: async (chatId) => {
      swaps.push(chatId);
      return options.swap === false ? null : { moved: true };
    },
    creditsUsable: () => options.credits ?? false,
    actorOf: async (chatId) =>
      chatId === "visitors" ? ({ kind: "visitor", accountId: "acct-v" } as never) : undefined,
    ...(options.continues ? { continues: options.continues } : {}),
    selectModel: (chatId, _agentName, selection, credits) => {
      selected.push({ chatId, selection, ...(credits !== undefined ? { credits } : {}) });
    },
    notify: {
      send: async (content) => {
        pushes.push(content.body ?? "");
        return { kind: "sent" } as never;
      },
    },
    delay: options.delay ?? (async () => {}),
    later: (ms, work) => {
      timers.push({ ms, work });
      return () => {
        const index = timers.findIndex((timer) => timer.work === work);
        if (index >= 0) timers.splice(index, 1);
      };
    },
  };
  const failures = createProviderFailures(deps);
  const accountChanged = async (provider: ProviderId) => {
    for (const listener of accountListeners) listener(provider, "refreshed");
    await flush();
  };
  /** The chat's newest card: the one it shows, unless that settled as moved. */
  const cardIn = (chatId: string): ProviderFailurePart | undefined => {
    let found: ProviderFailurePart | undefined;
    for (const message of messages.values()) {
      if (message.chatId !== chatId) continue;
      const card = message.parts.find(
        (part) => (part as { type?: string }).type === "provider_failure",
      );
      if (card) found = card as ProviderFailurePart;
    }
    return found;
  };
  /** The cards the chat draws: not a quiet retry, not one that moved on. */
  const shownCards = (chatId: string) =>
    [...messages.values()]
      .filter((message) => message.chatId === chatId)
      .flatMap((message) => message.parts as ProviderFailurePart[])
      .filter(
        (part) =>
          part.type === "provider_failure" && !part.retrying && part.resolved?.by !== "moved",
      );
  const notice = (): ProviderOutagePart | undefined =>
    [...messages.values()]
      .flatMap((message) => message.parts)
      .find((part) => (part as { type?: string }).type === "provider_outage") as
      | ProviderOutagePart
      | undefined;
  const fail = (chatId: string, failure: AgentTurnFailure, final = false) =>
    failures.failed(
      { chatId, agentName: "main", turnId: `t-${chatId}`, failure: { kind: "turn", failure } },
      { final },
    );
  return {
    failures,
    messages,
    settings,
    runs,
    pushes,
    swaps,
    kept,
    followed,
    chose,
    selected,
    timers,
    accountChanged,
    cardIn,
    shownCards,
    notice,
    fail,
  };
}

const quota: AgentTurnFailure = {
  provider: "anthropic",
  message: "Claude usage limit reached",
  code: "usage_limit",
};
const temporary: AgentTurnFailure = {
  provider: "anthropic",
  message: "overloaded",
  httpStatus: 529,
};
const opusLimit: AgentTurnFailure = {
  provider: "anthropic",
  message: "You've hit your Opus limit",
};
const notInPlan: AgentTurnFailure = {
  provider: "openai",
  message: "The model gpt-6-1-sol does not exist or you do not have access to it",
  providerError: "model_not_found",
};
const revoked: AgentTurnFailure = {
  provider: "openai",
  message: "Your ChatGPT login was revoked",
  code: "auth_revoked",
};
const spendCap: AgentTurnFailure = {
  provider: "anthropic",
  message: "You have reached your monthly spend limit",
};
const creditsUsedUp: AgentTurnFailure = {
  provider: "openai",
  message: "Rome credits are used up",
  code: "credits_used_up",
};

describe("automatic recovery, the same in every chat", () => {
  it("retries a temporary failure once, silently, and cards the retry's failure", async () => {
    const h = harness({ chat: {} }, { anthropic: reportOf("available") });
    await h.fail("chat", temporary);
    await flush();
    expect(h.runs).toHaveLength(1);
    expect(h.runs[0]?.prompt).toContain("<provider_retry>");
    // Only a quiet card while the retry waits: the turn reads as explained, not failed.
    expect(h.cardIn("chat")).toMatchObject({ retrying: true });
    expect(h.shownCards("chat")).toEqual([]);
    await h.fail("chat", temporary, true);
    expect(h.cardIn("chat")).toMatchObject({ card: "wait", reason: "temporary" });
    expect(h.cardIn("chat")?.retrying).toBeUndefined();
    expect(h.shownCards("chat")).toHaveLength(1);
    expect(h.runs).toHaveLength(1);
  });

  it("leaves a Concierge chat's first temporary failure to the Concierge's own retry", async () => {
    const h = harness({ main: { agentName: "concierge" } }, { anthropic: reportOf("available") });
    await h.fail("main", temporary);
    await flush();
    expect(h.runs).toEqual([]);
    expect(h.shownCards("main")).toEqual([]);
    await h.fail("main", temporary, true);
    expect(h.cardIn("main")).toMatchObject({ card: "wait", reason: "temporary" });
  });

  it("moves a chat that follows the default to another model of the provider", async () => {
    const h = harness({ chat: {} }, { anthropic: reportOf("available") });
    await h.fail("chat", opusLimit);
    await flush();
    expect(h.swaps).toEqual(["chat"]);
    expect(h.runs).toHaveLength(1);
    // Only a quiet card on the failed turn: the move's note says what happened.
    expect(h.shownCards("chat")).toEqual([]);
  });

  it("never moves a model its owner picked: a capacity limit shows the wait card", async () => {
    const h = harness(
      { chat: { largeModelSelection: "claude-opus-5-5", largeModelSelectionBy: "owner" } },
      { anthropic: reportOf("available"), openai: reportOf("available") },
    );
    await h.fail("chat", opusLimit);
    expect(h.swaps).toEqual([]);
    expect(h.cardIn("chat")).toMatchObject({
      card: "wait",
      reason: "capacity",
      followsDefault: false,
      model: "claude-opus-5-5[1m]",
      alternatives: ["openai"],
    });
  });

  it("shows the model card, with a model of the same provider, for a model not in the plan", async () => {
    const h = harness(
      { chat: { largeModelSelection: "gpt-6-1-sol", largeModelSelectionBy: "owner" } },
      { openai: reportOf("available"), anthropic: reportOf("available") },
      { defaultProvider: "openai" },
    );
    await h.fail("chat", notInPlan);
    expect(h.cardIn("chat")).toMatchObject({
      card: "model",
      reason: "model_unavailable",
      replacement: { selection: expect.any(String) },
      alternatives: [],
    });
  });

  it("moves a resumed turn to another model too, once in a row", async () => {
    const reports: ModelAccountReports = {
      openai: reportOf("usage_limit_reached"),
      anthropic: reportOf("available"),
    };
    const h = harness({ chat: {} }, reports, { defaultProvider: "openai" });
    const atCapacity: AgentTurnFailure = {
      provider: "openai",
      message: "Selected model is at capacity. Please try a different model.",
    };
    // A send refused on the quota, then resumed once the account reads available.
    await h.fail("chat", { provider: "openai", message: "usage limit", code: "usage_limit" }, true);
    reports.openai = reportOf("available");
    await h.accountChanged("openai");
    expect(h.runs).toHaveLength(1);
    // The resumed turn hits one model's limit: Rome moves the model, no card.
    await h.fail("chat", atCapacity);
    await flush();
    expect(h.swaps).toEqual(["chat"]);
    expect(h.runs).toHaveLength(2);
    // The moved model is limited too: now the card.
    await h.fail("chat", atCapacity);
    expect(h.swaps).toEqual(["chat"]);
    expect(h.cardIn("chat")).toMatchObject({ card: "wait", reason: "capacity" });
  });

  it("leaves the older turn's card hidden when the card moves on", async () => {
    const h = harness({ chat: {} }, { anthropic: reportOf("usage_limit_reached") });
    await h.fail("chat", quota);
    await h.fail("chat", spendCap);
    const parts = [...h.messages.values()].flatMap((m) => m.parts as ProviderFailurePart[]);
    expect(parts.map((part) => part.resolved?.by)).toEqual(["moved", undefined]);
  });

  it("cards a model limit no other model could take", async () => {
    const h = harness({ chat: {} }, { anthropic: reportOf("available") }, { swap: false });
    await h.fail("chat", opusLimit);
    expect(h.cardIn("chat")).toMatchObject({ card: "wait", reason: "capacity" });
  });

  it.each([
    ["a used-up quota", quota, "wait", "quota"],
    ["a revoked login", revoked, "account", "login"],
    ["a spending limit", spendCap, "account", "spend_cap"],
  ] as const)("shows a card, never another provider, for %s", async (_label, failure, card, reason) => {
    const h = harness(
      { chat: {} },
      {
        anthropic: reportOf(failure === quota ? "usage_limit_reached" : "available"),
        openai: reportOf(failure === revoked ? "expired" : "available"),
      },
    );
    await h.fail("chat", failure);
    await flush();
    expect(h.cardIn("chat")).toMatchObject({ card, reason });
    expect(h.runs).toEqual([]);
    expect(h.swaps).toEqual([]);
    expect(h.chose).toEqual([]);
    expect(h.kept).toEqual([]);
  });

  it("names Rome credits, and offers no switch, when their credits are used up", async () => {
    const h = harness(
      { chat: {} },
      { anthropic: reportOf("unauthorized"), openai: reportOf("unauthorized") },
      {
        defaultProvider: "rome_credits",
        signedIn: { anthropic: false, openai: false, rome_credits: true },
      },
    );
    await h.fail("chat", creditsUsedUp);
    expect(h.cardIn("chat")).toMatchObject({
      card: "account",
      reason: "credits_used_up",
      provider: "rome_credits",
      alternatives: [],
    });
    expect(h.cardIn("chat")?.credits).toBeUndefined();
  });
});

describe("the three cards", () => {
  it("offers a switch only to another account that can run", async () => {
    const h = harness(
      { chat: {} },
      { anthropic: reportOf("usage_limit_reached"), openai: reportOf("unauthorized") },
    );
    await h.fail("chat", quota);
    expect(h.cardIn("chat")).toMatchObject({ alternatives: [], until: expect.any(String) });
  });

  it("offers Rome credits only when no account is logged in and a balance is left", async () => {
    const notLoggedIn: AgentTurnFailure = {
      provider: "anthropic",
      message: "not logged in",
      reason: "not_logged_in",
    };
    const none = { anthropic: false, openai: false, rome_credits: true };
    const offered = harness(
      { chat: {} },
      { anthropic: reportOf("unauthorized"), openai: reportOf("unauthorized") },
      { signedIn: none, credits: true },
    );
    await offered.fail("chat", notLoggedIn);
    expect(offered.cardIn("chat")).toMatchObject({
      card: "account",
      reason: "removed",
      credits: true,
    });
    const empty = harness(
      { chat: {} },
      { anthropic: reportOf("unauthorized"), openai: reportOf("unauthorized") },
      { signedIn: none, credits: false },
    );
    await empty.fail("chat", notLoggedIn);
    expect(empty.cardIn("chat")?.credits).toBeUndefined();
  });

  it("learns a quota card's reset time from the account read that follows", async () => {
    const reports: ModelAccountReports = { openai: reportOf("available") };
    const h = harness({ chat: {} }, reports, { defaultProvider: "openai" });
    await h.fail("chat", {
      provider: "openai",
      message: "You've hit your usage limit.",
      code: "usage_limit",
    });
    expect(h.cardIn("chat")?.until).toBeUndefined();
    reports.openai = reportOf("usage_limit_reached", {}, "2026-11-20T14:20:00.000Z");
    await h.accountChanged("openai");
    expect(h.cardIn("chat")?.until).toBe("2026-11-20T14:20:00.000Z");
  });

  it("keeps the provider's error behind Details", async () => {
    const h = harness({ chat: {} }, { anthropic: reportOf("usage_limit_reached") });
    await h.fail("chat", quota);
    expect(h.cardIn("chat")?.detail).toBe("Claude usage limit reached");
  });

  it("moves a chat's open card to the newest failed turn, one card per chat", async () => {
    const h = harness(
      { chat: {} },
      { anthropic: reportOf("usage_limit_reached"), openai: reportOf("available") },
    );
    await h.fail("chat", quota);
    await h.fail("chat", spendCap);
    expect(h.shownCards("chat")).toHaveLength(1);
    expect(h.cardIn("chat")).toMatchObject({ reason: "spend_cap" });
    expect(await h.failures.cards()).toHaveLength(1);
  });

  it("switches this chat only, settles the card to one line, and runs the stopped turn", async () => {
    const h = harness(
      { chat: {} },
      { anthropic: reportOf("usage_limit_reached"), openai: reportOf("available") },
    );
    await h.fail("chat", quota);
    const [card] = await h.failures.cards();
    await h.failures.switchCard(card!.messageId, { kind: "provider", provider: "openai" });
    await flush();
    expect(h.kept).toEqual([{ chatId: "chat", provider: "openai" }]);
    expect(h.chose).toEqual([]);
    expect(h.cardIn("chat")?.resolved).toMatchObject({
      by: "switched",
      provider: "openai",
      continued: true,
    });
    expect(h.runs.map((run) => run.threadId)).toEqual(["chat"]);
    expect(await h.failures.cards()).toEqual([]);
  });

  it("runs the stopped turn once when Also make default moves the other chats", async () => {
    const h = harness(
      { chat: {}, other: {} },
      { anthropic: reportOf("usage_limit_reached"), openai: reportOf("available") },
    );
    await h.fail("chat", quota);
    await h.fail("other", quota);
    const card = (await h.failures.cards()).find((open) => open.chatId === "chat");
    await h.failures.switchCard(card!.messageId, {
      kind: "provider",
      provider: "openai",
      makeDefault: true,
    });
    await flush();
    expect(h.runs.map((run) => run.threadId).sort()).toEqual(["chat", "other"]);
  });

  it("keeps one card when the resumed turn fails again", async () => {
    const reports: ModelAccountReports = { anthropic: reportOf("usage_limit_reached") };
    const h = harness({ chat: {} }, reports);
    await h.fail("chat", quota);
    reports.anthropic = reportOf("available");
    await h.accountChanged("anthropic");
    await h.fail("chat", quota, true);
    await h.accountChanged("anthropic");
    expect(h.shownCards("chat")).toHaveLength(1);
    expect(h.runs).toHaveLength(1);
  });

  it("never resumes a quota card on an account that read available all along", async () => {
    // An API key has no usage window: its account reads available even while
    // the provider refuses every turn, so resuming on each read would loop.
    const h = harness({ chat: {} }, { anthropic: reportOf("available") }, { outcome: "failed" });
    await h.fail("chat", quota);
    for (let read = 0; read < 3; read++) await h.accountChanged("anthropic");
    expect(h.runs).toEqual([]);
    expect(h.cardIn("chat")?.resolved).toBeUndefined();
  });

  it("leaves a spending limit to the guardian when the account reads fine", async () => {
    const h = harness({ chat: {} }, { anthropic: reportOf("available") });
    await h.fail("chat", spendCap);
    await h.accountChanged("anthropic");
    expect(h.cardIn("chat")?.resolved).toBeUndefined();
    expect(h.runs).toEqual([]);
  });

  it("with Also make default, changes the default and moves every chat", async () => {
    const h = harness(
      { chat: {} },
      { anthropic: reportOf("usage_limit_reached"), openai: reportOf("available") },
    );
    await h.fail("chat", quota);
    const [card] = await h.failures.cards();
    await h.failures.switchCard(card!.messageId, {
      kind: "provider",
      provider: "openai",
      makeDefault: true,
    });
    expect(h.chose).toEqual([{ provider: "openai", moveExisting: true }]);
    expect(h.followed).toEqual(["chat"]);
    expect(h.kept).toEqual([]);
  });

  it("switches a model card to the model it names", async () => {
    const chats: Record<string, Row> = {
      chat: { largeModelSelection: "gpt-6-1-sol", largeModelSelectionBy: "owner" },
    };
    const h = harness(chats, { openai: reportOf("available") }, { defaultProvider: "openai" });
    await h.fail("chat", notInPlan);
    const [card] = await h.failures.cards();
    await h.failures.switchCard(card!.messageId, { kind: "model", selection: "gpt-5-6-terra" });
    expect(chats.chat).toMatchObject({
      largeModelSelection: "gpt-5-6-terra",
      largeModelSelectionBy: "owner",
    });
    expect(h.cardIn("chat")?.resolved).toMatchObject({
      by: "switched",
      model: expect.stringContaining("terra"),
    });
  });

  it("settles a card as recovered when the provider runs again, and resumes the turn", async () => {
    const reports: ModelAccountReports = {
      anthropic: reportOf("usage_limit_reached"),
      openai: reportOf("available"),
    };
    const h = harness({ chat: {} }, reports);
    await h.fail("chat", quota);
    expect(h.failures.carded("chat")).toBe(true);
    reports.anthropic = reportOf("available");
    await h.accountChanged("anthropic");
    expect(h.runs.map((run) => run.threadId)).toEqual(["chat"]);
    // The card settles once the stopped turn ran.
    await h.failures.succeeded("chat");
    expect(h.cardIn("chat")?.resolved).toMatchObject({ by: "recovered", continued: true });
    expect(h.failures.carded("chat")).toBe(false);
    // Another read resumes nothing more.
    await h.accountChanged("anthropic");
    expect(h.runs).toHaveLength(1);
  });

  it("settles a card when a later turn in the chat runs", async () => {
    const h = harness({ chat: {} }, { anthropic: reportOf("usage_limit_reached") });
    await h.fail("chat", quota);
    await h.failures.succeeded("chat");
    expect(h.cardIn("chat")?.resolved).toMatchObject({ by: "recovered" });
    expect(h.runs).toEqual([]);
  });

  it("tries a temporary card again later, by itself", async () => {
    const h = harness({ chat: {} }, { anthropic: reportOf("available") });
    await h.fail("chat", temporary, true);
    expect(h.timers.map((timer) => timer.ms)).toEqual([5 * 60_000]);
    h.timers[0]?.work();
    await flush();
    expect(h.runs.map((run) => run.threadId)).toEqual(["chat"]);
  });

  it("settles following chats' cards when the default moves, and leaves owner picks", async () => {
    const h = harness(
      {
        follows: {},
        picked: { largeModelSelection: "claude-opus-5-5", largeModelSelectionBy: "owner" },
      },
      { anthropic: reportOf("usage_limit_reached"), openai: reportOf("available") },
    );
    await h.fail("follows", quota);
    await h.fail("picked", quota);
    const [card] = await h.failures.cards();
    await h.failures.switchCard(card!.messageId, {
      kind: "provider",
      provider: "openai",
      makeDefault: true,
    });
    await flush();
    expect(h.cardIn("follows")?.resolved).toMatchObject({ by: "switched", provider: "openai" });
    expect(h.cardIn("picked")?.resolved).toBeUndefined();
  });
});

describe("unattended chats", () => {
  it("cards each task chat and groups them into one notice with one push", async () => {
    const h = harness(
      { a: { triggerKind: "concierge" }, b: { triggerKind: "concierge" }, main: {} },
      { anthropic: reportOf("usage_limit_reached"), openai: reportOf("available") },
    );
    for (const chatId of ["a", "b", "a"]) await h.fail(chatId, quota);
    expect(h.cardIn("a")).toMatchObject({ card: "wait" });
    expect(h.cardIn("b")).toMatchObject({ card: "wait" });
    expect(h.pushes).toEqual([expect.stringMatching(/^Claude quota used up.*\. 1 task waiting$/)]);
    expect(h.notice()).toMatchObject({
      type: "provider_outage",
      card: "wait",
      chatIds: ["a", "b"],
      alternatives: ["openai"],
    });
  });

  it("applies one click to every task, and the notice settles", async () => {
    const h = harness(
      { a: { triggerKind: "concierge" }, b: { triggerKind: "concierge" }, main: {} },
      { anthropic: reportOf("usage_limit_reached"), openai: reportOf("available") },
    );
    await h.fail("a", quota);
    await h.fail("b", quota);
    const [outage] = await h.failures.outages();
    expect(
      await h.failures.switchOutage(outage!.id, { kind: "provider", provider: "openai" }),
    ).toBe(2);
    await flush();
    expect(h.kept).toEqual([
      { chatId: "a", provider: "openai" },
      { chatId: "b", provider: "openai" },
    ]);
    expect(h.runs.map((run) => run.threadId).sort()).toEqual(["a", "b"]);
    expect(h.notice()?.resolved).toMatchObject({ by: "switched", provider: "openai" });
    expect(h.settings.get(PROVIDER_OUTAGES_SETTING_KEY)).toEqual([]);
    expect(h.settings.get(PROVIDER_CARDS_SETTING_KEY)).toEqual([]);
  });

  it("turns the notice into Recovered when the provider runs again", async () => {
    const reports: ModelAccountReports = {
      anthropic: reportOf("usage_limit_reached"),
      openai: reportOf("available"),
    };
    const h = harness({ a: { triggerKind: "concierge" }, main: {} }, reports);
    await h.fail("a", quota);
    reports.anthropic = reportOf("available");
    await h.accountChanged("anthropic");
    await h.failures.succeeded("a");
    expect(h.notice()?.resolved).toMatchObject({ by: "recovered" });
    expect(await h.failures.outages()).toEqual([]);
    expect(h.runs.map((run) => run.threadId)).toEqual(["a"]);
  });

  it("words the push by reason and counts the tasks", () => {
    expect(
      outagePushText({
        provider: "openai",
        reason: "login",
        chats: [
          { chatId: "a", agentName: "main" },
          { chatId: "b", agentName: "main" },
        ],
      }),
    ).toBe("ChatGPT needs you to log in again. 2 tasks waiting");
  });
});

it("ignores a failure that is neither a provider's nor temporary", async () => {
  const h = harness({ chat: {} }, { anthropic: reportOf("available") });
  await h.fail("chat", { provider: "anthropic", message: "prompt is too long" });
  await flush();
  expect(h.messages.size).toBe(0);
  expect(h.runs).toEqual([]);
});

const refused = (
  provider: "openai" | "anthropic",
  reason: "not_logged_in" | "quota_exhausted",
) => ({
  kind: "resolution" as const,
  payload: {
    error: "refused",
    code: "model_provider_unavailable" as const,
    provider,
    reason,
  },
});
const never = () => new Promise<void>(() => {});

describe("a card resumes its turn, once", () => {
  it("resumes a quota card written while the account still read available, once the limit lifts", async () => {
    const reports: ModelAccountReports = { anthropic: reportOf("available") };
    const h = harness({ chat: {} }, reports);
    await h.fail("chat", quota);
    reports.anthropic = reportOf("usage_limit_reached");
    await h.accountChanged("anthropic");
    expect(h.runs).toEqual([]);
    reports.anthropic = reportOf("available");
    await h.accountChanged("anthropic");
    await h.accountChanged("anthropic");
    expect(h.runs.map((run) => run.threadId)).toEqual(["chat"]);
  });

  it("resumes a login card once the guardian logs in again", async () => {
    const reports: ModelAccountReports = {
      openai: reportOf("available"),
      anthropic: reportOf("available"),
    };
    const h = harness({ chat: {} }, reports, { defaultProvider: "openai" });
    await h.fail("chat", revoked);
    expect(h.cardIn("chat")).toMatchObject({ card: "account", reason: "login" });
    reports.openai = reportOf("expired");
    await h.accountChanged("openai");
    reports.openai = reportOf("available");
    await h.accountChanged("openai");
    await h.accountChanged("openai");
    expect(h.runs.map((run) => run.threadId)).toEqual(["chat"]);
  });

  it("runs the turn once when Switch is clicked twice", async () => {
    const h = harness(
      { chat: {} },
      { anthropic: reportOf("usage_limit_reached"), openai: reportOf("available") },
    );
    await h.fail("chat", quota);
    const [card] = await h.failures.cards();
    const change = { kind: "provider", provider: "openai" } as const;
    const results = await Promise.allSettled([
      h.failures.switchCard(card!.messageId, change),
      h.failures.switchCard(card!.messageId, change),
    ]);
    await flush();
    expect(results.map((result) => result.status).sort()).toEqual(["fulfilled", "rejected"]);
    expect(h.runs.map((run) => run.threadId)).toEqual(["chat"]);
  });

  it("runs each task once when the notice's switch is clicked twice", async () => {
    const h = harness(
      { a: { triggerKind: "concierge" }, b: { triggerKind: "concierge" }, main: {} },
      { anthropic: reportOf("usage_limit_reached"), openai: reportOf("available") },
    );
    await h.fail("a", quota);
    await h.fail("b", quota);
    const [outage] = await h.failures.outages();
    const change = { kind: "provider", provider: "openai" } as const;
    await Promise.allSettled([
      h.failures.switchOutage(outage!.id, change),
      h.failures.switchOutage(outage!.id, change),
    ]);
    await flush();
    expect(h.runs.map((run) => run.threadId).sort()).toEqual(["a", "b"]);
  });

  it("runs the turn once when a switch races the account recovering", async () => {
    const reports: ModelAccountReports = {
      anthropic: reportOf("usage_limit_reached"),
      openai: reportOf("available"),
    };
    let release = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const h = harness({ chat: {} }, reports, { onRun: () => held });
    await h.fail("chat", quota);
    const [card] = await h.failures.cards();
    reports.anthropic = reportOf("available");
    await h.accountChanged("anthropic");
    await h.failures.switchCard(card!.messageId, { kind: "provider", provider: "openai" });
    release();
    await flush();
    expect(h.runs.map((run) => run.threadId)).toEqual(["chat"]);
  });

  it("runs a switch's turn after a restart that came before it started", async () => {
    const settings = new Map<string, unknown>([
      [PROVIDER_RESUMES_SETTING_KEY, [{ chatId: "chat", agentName: "main", name: "ChatGPT" }]],
    ]);
    const h = harness({ chat: {} }, { openai: reportOf("available") }, { settings });
    await flush();
    expect(h.runs.map((run) => run.threadId)).toEqual(["chat"]);
    expect(settings.get(PROVIDER_RESUMES_SETTING_KEY)).toEqual([]);
  });

  it("clears the promise to run once the switch's turn starts", async () => {
    const h = harness(
      { chat: {} },
      { anthropic: reportOf("usage_limit_reached"), openai: reportOf("available") },
    );
    await h.fail("chat", quota);
    const [card] = await h.failures.cards();
    await h.failures.switchCard(card!.messageId, { kind: "provider", provider: "openai" });
    await flush();
    expect(h.settings.get(PROVIDER_RESUMES_SETTING_KEY)).toEqual([]);
  });
});

describe("Rome credits, spent only when the guardian chose them", () => {
  it("shows the account card with Use Rome credits for a chat that follows ChatGPT after its login went", async () => {
    const h = harness(
      { chat: {} },
      { openai: reportOf("unauthorized"), anthropic: reportOf("unauthorized") },
      {
        defaultProvider: "openai",
        signedIn: { anthropic: false, openai: false, rome_credits: true },
        credits: true,
      },
    );
    const part = await h.failures.cardFor(
      { chatId: "chat", agentName: "main", failure: refused("openai", "not_logged_in") },
      "m-card",
      [],
    );
    expect(part).toMatchObject({
      card: "account",
      reason: "removed",
      provider: "openai",
      credits: true,
    });
  });

  it("says Rome credits are used up, not that ChatGPT is logged out, for a chat on them", async () => {
    const h = harness(
      {
        chat: {
          largeModelSelection: "claude-opus-5-5",
          largeModelSelectionBy: "owner",
          romeCredits: true,
        },
      },
      { openai: reportOf("unauthorized"), anthropic: reportOf("unauthorized") },
      {
        defaultProvider: "openai",
        signedIn: { anthropic: false, openai: false, rome_credits: true },
      },
    );
    const part = await h.failures.cardFor(
      { chatId: "chat", agentName: "main", failure: refused("openai", "not_logged_in") },
      "m-card",
      [],
    );
    expect(part).toMatchObject({ reason: "credits_used_up", provider: "rome_credits" });
    expect(part?.credits).toBeUndefined();
  });

  it("moves only this chat onto Rome credits, or makes them the default as Settings would", async () => {
    const chats = { a: {}, b: {} };
    const reports: ModelAccountReports = {
      openai: reportOf("unauthorized"),
      anthropic: reportOf("unauthorized"),
    };
    const options = {
      defaultProvider: "openai" as const,
      signedIn: { anthropic: false, openai: false, rome_credits: true },
      credits: true,
    };
    const h = harness(chats, reports, options);
    await h.fail("a", revoked);
    await h.fail("b", revoked);
    const cards = await h.failures.cards();
    const of = (chatId: string) => cards.find((card) => card.chatId === chatId)!.messageId;
    await h.failures.switchCard(of("a"), { kind: "provider", provider: "rome_credits" });
    expect(h.kept).toEqual([{ chatId: "a", provider: "rome_credits" }]);
    expect(h.chose).toEqual([]);
    await h.failures.switchCard(of("b"), {
      kind: "provider",
      provider: "rome_credits",
      makeDefault: true,
      moveExisting: false,
    });
    expect(h.chose).toEqual([{ provider: "rome_credits", moveExisting: false }]);
    expect(h.followed).toEqual(["b"]);
  });
});

describe("Also make default on a card", () => {
  it("leaves the other chats where they are when Move existing chats too is off", async () => {
    const h = harness(
      { chat: {}, other: {} },
      { anthropic: reportOf("usage_limit_reached"), openai: reportOf("available") },
    );
    await h.fail("chat", quota);
    await h.fail("other", quota);
    const card = (await h.failures.cards()).find((open) => open.chatId === "chat");
    await h.failures.switchCard(card!.messageId, {
      kind: "provider",
      provider: "openai",
      makeDefault: true,
      moveExisting: false,
    });
    await flush();
    expect(h.chose).toEqual([{ provider: "openai", moveExisting: false }]);
    expect(h.runs.map((run) => run.threadId)).toEqual(["chat"]);
    expect(h.cardIn("other")?.resolved).toBeUndefined();
  });
});

describe("the silent retry", () => {
  it("retries here a Concierge chat on an API key, which the Concierge does not retry", async () => {
    const h = harness(
      { main: { agentName: "concierge" } },
      { anthropic: reportOf("available", { usageLimited: false }) },
    );
    await h.fail("main", temporary);
    await flush();
    expect(h.runs.map((run) => run.threadId)).toEqual(["main"]);
  });

  it("cards the retry's failure as final, from the turn's own end event", async () => {
    const h = harness(
      { chat: {} },
      { anthropic: reportOf("available") },
      {
        // The retry's end event reaches the cards while its run is finishing.
        onRun: (params, failures) => {
          void failures.failed({
            chatId: params.threadId,
            agentName: "main",
            turnId: "t-retry",
            failure: { kind: "turn", failure: temporary },
          });
        },
      },
    );
    await h.fail("chat", temporary);
    await flush();
    expect(h.runs).toHaveLength(1);
    expect(h.shownCards("chat")).toEqual([
      expect.objectContaining({ card: "wait", reason: "temporary" }),
    ]);
  });

  it("runs a quiet card's lost retry after a restart", async () => {
    const reports: ModelAccountReports = { anthropic: reportOf("available") };
    const first = harness({ chat: {} }, reports, { delay: never });
    await first.fail("chat", temporary);
    first.failures.stop();
    const after = harness({ chat: {} }, reports, { settings: first.settings });
    await flush();
    expect(after.timers.map((timer) => timer.ms)).toEqual([30_000]);
    after.timers[0]?.work();
    await flush();
    expect(after.runs.map((run) => run.threadId)).toEqual(["chat"]);
  });

  it("leaves a quiet card to its retry when the default moves", async () => {
    const h = harness(
      { chat: {}, other: {} },
      { anthropic: reportOf("available"), openai: reportOf("available") },
      { delay: never },
    );
    await h.fail("chat", temporary);
    await h.fail("other", quota);
    const card = (await h.failures.cards()).find((open) => open.chatId === "other");
    await h.failures.switchCard(card!.messageId, {
      kind: "provider",
      provider: "openai",
      makeDefault: true,
    });
    await flush();
    expect(h.runs.map((run) => run.threadId)).toEqual(["other"]);
    expect(h.cardIn("chat")).toMatchObject({ retrying: true });
    expect(h.cardIn("chat")?.resolved).toBeUndefined();
  });
});

describe("a refused send's card", () => {
  it("takes its settled form when it settled before its message was written", async () => {
    const h = harness({ chat: {} }, { anthropic: reportOf("usage_limit_reached") });
    const part = await h.failures.cardFor(
      { chatId: "chat", agentName: "main", failure: refused("anthropic", "quota_exhausted") },
      "late",
      [],
    );
    await h.failures.succeeded("chat");
    h.messages.set("late", { chatId: "chat", parts: [part] });
    await h.failures.written("late");
    expect(h.cardIn("chat")?.resolved).toMatchObject({ by: "recovered" });
  });
});

describe("round 5: what the second review found", () => {
  it("tries a quota card's turn again once its limit resets, with no account read in between", async () => {
    const until = new Date(Date.now() + 60 * 60_000).toISOString();
    const reports: ModelAccountReports = {
      anthropic: reportOf("usage_limit_reached", {}, until),
    };
    const h = harness({ chat: {} }, reports);
    await h.fail("chat", quota);
    const timer = h.timers.at(-1);
    // Due a little after the reset, not on the 5-minute recovery steps.
    expect(timer?.ms).toBeGreaterThan(59 * 60_000);
    reports.anthropic = reportOf("available");
    timer?.work();
    await flush();
    expect(h.runs.map((run) => run.threadId)).toEqual(["chat"]);
  });

  it("schedules a quota card's retry once the account read names its reset time", async () => {
    const reports: ModelAccountReports = { anthropic: reportOf("available") };
    const h = harness({ chat: {} }, reports);
    await h.fail("chat", quota);
    expect(h.timers).toEqual([]);
    reports.anthropic = reportOf(
      "usage_limit_reached",
      {},
      new Date(Date.now() + 10 * 60_000).toISOString(),
    );
    await h.accountChanged("anthropic");
    expect(h.timers).toHaveLength(1);
  });

  it("leaves a card a switch took to the switch when its recovery timer fires", async () => {
    let release = () => {};
    const keeping = new Promise<void>((resolve) => {
      release = resolve;
    });
    const h = harness(
      { chat: {} },
      { anthropic: reportOf("available"), openai: reportOf("available") },
      { keeping },
    );
    await h.fail("chat", { provider: "anthropic", message: "overloaded", httpStatus: 529 }, true);
    const [card] = await h.failures.cards();
    const switched = h.failures.switchCard(card!.messageId, {
      kind: "provider",
      provider: "openai",
    });
    await flush();
    // The recovery fires while the switch is still moving the chat.
    h.timers.at(-1)?.work();
    await flush();
    expect(h.runs).toEqual([]);
    release();
    await switched;
    await flush();
    expect(h.runs.map((run) => run.threadId)).toEqual(["chat"]);
    expect(h.cardIn("chat")?.resolved).toMatchObject({ by: "switched", provider: "openai" });
  });

  it("settles once when the notice's switch races a task's own card", async () => {
    const h = harness(
      { a: { triggerKind: "concierge" }, b: { triggerKind: "concierge" }, main: {} },
      { anthropic: reportOf("usage_limit_reached"), openai: reportOf("available") },
    );
    await h.fail("a", quota);
    await h.fail("b", quota);
    const [outage] = await h.failures.outages();
    const cardOfA = (await h.failures.cards()).find((card) => card.chatId === "a")!;
    const change = { kind: "provider", provider: "openai" } as const;
    const results = await Promise.allSettled([
      h.failures.switchOutage(outage!.id, change),
      h.failures.switchCard(cardOfA.messageId, change),
    ]);
    await flush();
    expect(results.map((result) => result.status)).toEqual(["fulfilled", "rejected"]);
    expect(h.runs.map((run) => run.threadId).sort()).toEqual(["a", "b"]);
    expect(h.kept.map((keep) => keep.chatId).sort()).toEqual(["a", "b"]);
  });

  it("keeps a switch's resume marker until the turn starts, so a restart runs it", async () => {
    const h = harness(
      { chat: {} },
      { anthropic: reportOf("usage_limit_reached"), openai: reportOf("available") },
      { runtimeOf: async () => null },
    );
    await h.fail("chat", quota);
    const [card] = await h.failures.cards();
    await h.failures.switchCard(card!.messageId, { kind: "provider", provider: "openai" });
    await flush();
    expect(h.runs).toEqual([]);
    expect(h.settings.get(PROVIDER_RESUMES_SETTING_KEY)).toEqual([
      expect.objectContaining({ chatId: "chat" }),
    ]);
    const after = harness(
      { chat: {} },
      { anthropic: reportOf("usage_limit_reached"), openai: reportOf("available") },
      { settings: h.settings },
    );
    await flush();
    expect(after.runs.map((run) => run.threadId)).toEqual(["chat"]);
    expect(after.settings.get(PROVIDER_RESUMES_SETTING_KEY)).toEqual([]);
  });

  it("moves a chat whose owner picked its model onto Rome credits, keeping the pick", async () => {
    const chats: Record<string, Row> = {
      chat: { largeModelSelection: "claude-opus-5-5", largeModelSelectionBy: "owner" },
    };
    const h = harness(
      chats,
      { openai: reportOf("unauthorized"), anthropic: reportOf("unauthorized") },
      {
        defaultProvider: "anthropic",
        signedIn: { anthropic: false, openai: false, rome_credits: true },
        credits: true,
      },
    );
    await h.fail("chat", {
      provider: "anthropic",
      message: "not logged in",
      reason: "not_logged_in",
    });
    const [card] = await h.failures.cards();
    await h.failures.switchCard(card!.messageId, { kind: "provider", provider: "rome_credits" });
    expect(h.kept).toEqual([{ chatId: "chat", provider: "rome_credits" }]);
    expect(chats.chat).toMatchObject({
      largeModelSelection: "claude-opus-5-5",
      largeModelSelectionBy: "owner",
      romeCredits: true,
    });
  });

  it("names ChatGPT, not Rome credits, once a chat's flag outlives a ChatGPT login", async () => {
    const h = harness(
      { chat: { romeCredits: true } },
      { openai: reportOf("expired"), anthropic: reportOf("unauthorized") },
      {
        defaultProvider: "openai",
        signedIn: { anthropic: false, openai: true, rome_credits: false },
      },
    );
    await h.fail("chat", revoked);
    expect(h.cardIn("chat")).toMatchObject({ provider: "openai", reason: "login" });
  });

  it("keeps a chat on Rome credits when its card switches it to another model", async () => {
    const h = harness(
      { chat: { romeCredits: true } },
      { openai: reportOf("available") },
      {
        defaultProvider: "rome_credits",
        signedIn: { anthropic: false, openai: false, rome_credits: true },
      },
    );
    await h.fail("chat", notInPlan, true);
    const [card] = await h.failures.cards();
    await h.failures.switchCard(card!.messageId, { kind: "model", selection: "gpt-6-luna" });
    expect(h.selected).toEqual([{ chatId: "chat", selection: "gpt-6-luna", credits: true }]);
  });

  it("writes a refused send's card settled when it settled before its message existed", async () => {
    const h = harness({ chat: {} }, { anthropic: reportOf("usage_limit_reached") });
    const part = await h.failures.cardFor(
      { chatId: "chat", agentName: "main", failure: refused("anthropic", "quota_exhausted") },
      "late",
      [],
    );
    // The repository writes nothing for a message not there yet, and throws nothing.
    await h.failures.succeeded("chat");
    expect(h.messages.has("late")).toBe(false);
    h.messages.set("late", { chatId: "chat", parts: [part] });
    await h.failures.written("late");
    expect(h.cardIn("chat")?.resolved).toMatchObject({ by: "recovered", continued: true });
  });
});

describe("the silent retry, bound to its card", () => {
  const held = () => {
    let release = () => {};
    const wait = new Promise<void>((resolve) => {
      release = resolve;
    });
    return { wait, release };
  };

  it("leaves the turn to a switch that settles its card while it waits", async () => {
    const pause = held();
    const h = harness(
      { chat: {} },
      { anthropic: reportOf("available"), openai: reportOf("available") },
      { delay: () => pause.wait },
    );
    await h.fail("chat", temporary);
    const [card] = await h.failures.cards();
    await h.failures.switchCard(card!.messageId, { kind: "provider", provider: "openai" });
    await flush();
    pause.release();
    await flush();
    // The switch ran the turn, once; the retry that waited ran nothing.
    expect(h.runs.map((run) => run.threadId)).toEqual(["chat"]);
    // The resumed turn names the provider that could not run it.
    expect(h.runs[0]?.prompt).toContain("because Claude could not run it");
  });

  it("is dropped by a turn that ran, or a newer failure, before it starts", async () => {
    const pause = held();
    const h = harness(
      { chat: {} },
      { anthropic: reportOf("available") },
      {
        delay: () => pause.wait,
      },
    );
    await h.fail("chat", temporary);
    await h.failures.succeeded("chat");
    pause.release();
    await flush();
    expect(h.runs).toEqual([]);
  });
});

describe("whose main chat a notice is in", () => {
  it("groups a visitor's stopped task in that visitor's main chat, with no push to the guardian", async () => {
    const h = harness(
      {
        mine: { triggerKind: "concierge" },
        theirs: { triggerKind: "concierge", ownerKey: "visitor:acct-v" },
        main: {},
        "main-visitor:acct-v": { ownerKey: "visitor:acct-v" },
      },
      { anthropic: reportOf("usage_limit_reached"), openai: reportOf("available") },
    );
    await h.fail("mine", quota);
    await h.fail("theirs", quota);
    const outages = await h.failures.outages();
    expect(
      outages.map((outage) => [outage.noticeChatId, outage.chats.map((c) => c.chatId)]),
    ).toEqual([
      ["main", ["mine"]],
      ["main-visitor:acct-v", ["theirs"]],
    ]);
    expect(h.pushes).toHaveLength(1);
  });
});

describe("a turn resumed by itself", () => {
  it("runs only when the usage-limit continuation would, else its card settles quietly", async () => {
    const reports: ModelAccountReports = { anthropic: reportOf("usage_limit_reached") };
    const h = harness({ chat: {}, other: {} }, reports, {
      // The guardian wrote in "other" since its turn stopped.
      continues: (chatId) => chatId !== "other",
    });
    await h.fail("chat", quota);
    await h.fail("other", quota);
    reports.anthropic = reportOf("available");
    await h.accountChanged("anthropic");
    expect(h.runs.map((run) => run.threadId)).toEqual(["chat"]);
    expect(h.cardIn("other")?.resolved).toMatchObject({ by: "recovered" });
    expect(h.cardIn("other")?.resolved?.continued).toBeUndefined();
  });

  it("names the provider that failed when a default change resumes it", async () => {
    const h = harness(
      { chat: {}, other: {} },
      { anthropic: reportOf("usage_limit_reached"), openai: reportOf("available") },
    );
    await h.fail("chat", quota);
    await h.fail("other", quota);
    const card = (await h.failures.cards()).find((open) => open.chatId === "chat");
    await h.failures.switchCard(card!.messageId, {
      kind: "provider",
      provider: "openai",
      makeDefault: true,
    });
    await flush();
    expect(h.runs.map((run) => run.threadId).sort()).toEqual(["chat", "other"]);
    for (const run of h.runs) expect(run.prompt).toContain("because Claude could not run it");
  });
});

describe("a model the resolver refused", () => {
  it("offers the provider's other model on its card", async () => {
    const h = harness(
      { chat: { largeModelSelection: "gpt-6-1-sol", largeModelSelectionBy: "owner" } },
      { openai: reportOf("available") },
      { defaultProvider: "openai" },
    );
    const part = await h.failures.cardFor(
      {
        chatId: "chat",
        agentName: "main",
        failure: {
          kind: "resolution",
          payload: {
            error: "Selected model is unavailable: gpt-6.1-sol",
            code: "model_unavailable",
            provider: "openai",
            reason: "model_access_denied",
            model: "gpt-6.1-sol",
          },
        },
      },
      "m-card",
      [],
    );
    expect(part).toMatchObject({ card: "model", replacement: { selection: expect.any(String) } });
    expect(part?.replacement?.selection).not.toBe("gpt-6-1-sol");
  });
});

describe("a recovery turn", () => {
  it("acts for the chat's owner, as a continuation does", async () => {
    const h = harness(
      { visitors: {} },
      { anthropic: reportOf("usage_limit_reached"), openai: reportOf("available") },
    );
    await h.fail("visitors", quota);
    const [card] = await h.failures.cards();
    await h.failures.switchCard(card!.messageId, { kind: "provider", provider: "openai" });
    await flush();
    expect(h.runs[0]?.actor).toMatchObject({ kind: "visitor", accountId: "acct-v" });
  });

  it("names Rome credits used up while no ChatGPT account is logged in, though the balance is gone", async () => {
    const h = harness(
      { chat: { romeCredits: true } },
      { openai: reportOf("unauthorized"), anthropic: reportOf("unauthorized") },
      {
        defaultProvider: "openai",
        signedIn: { anthropic: false, openai: false, rome_credits: false },
      },
    );
    await h.fail("chat", revoked);
    expect(h.cardIn("chat")).toMatchObject({ provider: "rome_credits", reason: "credits_used_up" });
  });
});
