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
  type ProviderFailuresDeps,
} from "./provider-failures.js";

type Row = {
  largeModelSelection?: string | null;
  largeModelSelectionBy?: "owner" | "auto" | "kept" | null;
  triggerKind?: string | null;
  agentName?: string | null;
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
  } = {},
) {
  const messages = new Map<string, { chatId: string; parts: unknown[] }>();
  const settings = new Map<string, unknown>();
  const runs: Array<{ threadId: string; prompt: string }> = [];
  const pushes: string[] = [];
  const swaps: string[] = [];
  const kept: Array<{ chatId: string; provider: string }> = [];
  const followed: string[] = [];
  const chose: Array<{ provider: string; moveExisting?: boolean }> = [];
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
        kept.push({ chatId, provider });
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
              ...chats[id],
            }
          : null,
      addBackendMessage: async (chatId: string, _turnId: string, parts: unknown[]) => {
        const id = `m${messages.size}`;
        messages.set(id, { chatId, parts });
        return { id };
      },
      updateMessageContent: async (id: string, content: string) => {
        const message = messages.get(id);
        messages.set(id, { chatId: message?.chatId ?? "?", parts: JSON.parse(content) });
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
    mainChatId: async () => "main",
    runtimeOf: async (chatId) => `session-${chatId}`,
    runner: {
      runAndReport: async (params) => {
        runs.push({ threadId: params.threadId, prompt: params.prompt });
        return options.outcome ?? "completed";
      },
    },
    swapModel: async (chatId) => {
      swaps.push(chatId);
      return options.swap === false ? null : { moved: true };
    },
    creditsUsable: () => options.credits ?? false,
    notify: {
      send: async (content) => {
        pushes.push(content.body ?? "");
        return { kind: "sent" } as never;
      },
    },
    delay: async () => {},
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
  /** The parts of the message the chat's card is in. */
  const cardIn = (chatId: string): ProviderFailurePart | undefined => {
    for (const message of messages.values()) {
      if (message.chatId !== chatId) continue;
      const card = message.parts.find(
        (part) => (part as { type?: string }).type === "provider_failure",
      );
      if (card) return card as ProviderFailurePart;
    }
    return undefined;
  };
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
    timers,
    accountChanged,
    cardIn,
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
    expect(h.cardIn("chat")).toBeUndefined();
    await h.fail("chat", temporary, true);
    expect(h.cardIn("chat")).toMatchObject({ card: "wait", reason: "temporary" });
    expect(h.runs).toHaveLength(1);
  });

  it("leaves a Concierge chat's first temporary failure to the Concierge's own retry", async () => {
    const h = harness({ main: { agentName: "concierge" } }, { anthropic: reportOf("available") });
    await h.fail("main", temporary);
    await flush();
    expect(h.runs).toEqual([]);
    expect(h.cardIn("main")).toBeUndefined();
    await h.fail("main", temporary, true);
    expect(h.cardIn("main")).toMatchObject({ card: "wait", reason: "temporary" });
  });

  it("moves a chat that follows the default to another model of the provider", async () => {
    const h = harness({ chat: {} }, { anthropic: reportOf("available") });
    await h.fail("chat", opusLimit);
    await flush();
    expect(h.swaps).toEqual(["chat"]);
    expect(h.runs).toHaveLength(1);
    expect(h.cardIn("chat")).toBeUndefined();
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
        credits: true,
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
    const withCards = [...h.messages.values()].filter((message) =>
      message.parts.some((part) => (part as { type?: string }).type === "provider_failure"),
    );
    expect(withCards).toHaveLength(1);
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
    const withCards = [...h.messages.values()].filter((message) =>
      message.parts.some((part) => (part as { type?: string }).type === "provider_failure"),
    );
    expect(withCards).toHaveLength(1);
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
