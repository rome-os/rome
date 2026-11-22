import { describe, expect, it } from "@rstest/core";
import type { AgentTurnFailure } from "@rome-os/app-runtime";
import type { ProviderFailurePart, ProviderOutagePart } from "@rome/api-types/chat";
import type { DefaultProvider, ModelAccountReports, ProviderId } from "../agent/index.js";
import { reportOf } from "../test/kit/model-accounts.js";
import {
  createProviderFailures,
  outagePushText,
  PROVIDER_CARDS_SETTING_KEY,
  PROVIDER_OUTAGES_SETTING_KEY,
  type ProviderFailures,
  type ProviderFailuresDeps,
} from "./provider-failures.js";

type Row = {
  largeModelSelection?: string | null;
  largeModelSelectionBy?: "owner" | "auto" | "kept" | null;
  triggerKind?: string | null;
  agentName?: string | null;
  ownerKey?: string | null;
};

const flush = async () => {
  for (let i = 0; i < 5; i++) await new Promise((resolve) => setTimeout(resolve, 0));
};

const held = () => {
  let release = () => {};
  const wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { wait, release };
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
    /** What a recovery turn waits on in the chat's queue before it is dispatched. */
    queue?: Promise<void>;
    /** The chats held on a provider. Default: none. */
    held?: string[];
    /** Whether someone wrote in the chat since. Default: nobody did. */
    movedOnSince?: (chatId: string, since: number) => boolean;
    /** Whether the usage-limit continuation takes the chat. Default: it does not. */
    continuesAfterLimit?: (chatId: string, until: string) => boolean;
  } = {},
) {
  const messages = new Map<string, { chatId: string; parts: unknown[] }>();
  const settings = options.settings ?? new Map<string, unknown>();
  const runs: Array<{ threadId: string; prompt: string; actor?: unknown }> = [];
  const pushes: string[] = [];
  const swaps: string[] = [];
  const kept: Array<{ chatId: string; provider: string }> = [];
  const followed: string[] = [];
  const released: string[] = [];
  const chose: Array<{ provider: string; moveExisting?: boolean }> = [];
  const selected: Array<{ chatId: string; selection: string | null }> = [];
  const accountListeners = new Set<
    (provider: ProviderId, change: "authorization" | "refreshed") => void
  >();
  let defaultProvider: DefaultProvider = options.defaultProvider ?? "anthropic";
  let chooseFails: Error | undefined;
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
        if (chooseFails) {
          const error = chooseFails;
          chooseFails = undefined;
          throw error;
        }
        chose.push({ provider, ...(choice ? { moveExisting: choice.moveExisting } : {}) });
        defaultProvider = provider;
      },
    },
    chats: {
      keep: async (chatId, provider) => {
        kept.push({ chatId, provider });
        return "claude-opus-5-5";
      },
      follow: async (chatId) => {
        followed.push(chatId);
        return null;
      },
      release: async (chatId) => {
        released.push(chatId);
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
      // As the repository does: a message not written yet is left alone.
      updateMessageContent: async (id: string, content: string) => {
        const message = messages.get(id);
        if (!message) return false;
        messages.set(id, { chatId: message.chatId, parts: JSON.parse(content) });
        return true;
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
      // As the real runner: the turn waits its turn in the queue, then asks
      // `shouldRun` once more and runs only if it still should.
      runAndReport: async (params, runOptions) => {
        await options.queue;
        if (runOptions?.shouldRun && !runOptions.shouldRun()) return "completed";
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
    held: (chatId) => options.held?.includes(chatId) ?? false,
    actorOf: async (chatId) =>
      chatId === "visitors" ? ({ kind: "visitor", accountId: "acct-v" } as never) : undefined,
    ...(options.movedOnSince ? { movedOnSince: options.movedOnSince } : {}),
    ...(options.continuesAfterLimit ? { continuesAfterLimit: options.continuesAfterLimit } : {}),
    selectModel: (chatId, _agentName, selection) => {
      selected.push({ chatId, selection });
    },
    notify: {
      send: async (content) => {
        pushes.push(content.body ?? "");
        return { kind: "sent" } as never;
      },
    },
    delay: options.delay ?? (async () => {}),
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
  const notice = (chatId = "main"): ProviderOutagePart | undefined =>
    [...messages.values()]
      .filter((message) => message.chatId === chatId)
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
    released,
    chose,
    selected,
    accountChanged,
    cardIn,
    shownCards,
    notice,
    fail,
    defaultProvider: () => defaultProvider,
    failNextChoose: (error: Error) => {
      chooseFails = error;
    },
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
const notLoggedIn: AgentTurnFailure = {
  provider: "anthropic",
  message: "not logged in",
  reason: "not_logged_in",
};
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
/** No AI account logged in: Rome credits are the only provider left. */
const noAccount = { anthropic: false, openai: false, rome_credits: true };

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

  it("settles the quiet card silently once its retry gets past the failure", async () => {
    const h = harness({ chat: {} }, { anthropic: reportOf("available") });
    await h.fail("chat", temporary);
    await flush();
    // The retry is Rome's own turn: it answers no one, yet it ran the stopped request.
    await h.failures.succeeded("chat", false);
    expect(h.cardIn("chat")?.resolved).toMatchObject({ by: "moved" });
    expect(await h.failures.cards()).toEqual([]);
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

  it("drops the silent retry for a turn that ran, or a newer failure, before it starts", async () => {
    const pause = held();
    const h = harness(
      { chat: {} },
      { anthropic: reportOf("available") },
      { delay: () => pause.wait },
    );
    await h.fail("chat", temporary);
    await h.failures.succeeded("chat");
    pause.release();
    await flush();
    expect(h.runs).toEqual([]);
  });

  it("keeps the silent retry when only a system turn ran meanwhile", async () => {
    const pause = held();
    const h = harness(
      { chat: {} },
      { anthropic: reportOf("available") },
      { delay: () => pause.wait },
    );
    await h.fail("chat", temporary);
    // A Concierge report ran in the chat meanwhile.
    await h.failures.succeeded("chat", false);
    expect(h.cardIn("chat")).toMatchObject({ retrying: true });
    expect(h.cardIn("chat")?.resolved).toBeUndefined();
    pause.release();
    await flush();
    expect(h.runs.map((run) => run.threadId)).toEqual(["chat"]);
  });

  it("forgets the silent retry on a restart: the quiet card waits for the next turn", async () => {
    const reports: ModelAccountReports = { anthropic: reportOf("available") };
    const first = harness({ chat: {} }, reports, { delay: never });
    await first.fail("chat", temporary);
    first.failures.stop();
    const after = harness({ chat: {} }, reports, { settings: first.settings });
    await flush();
    expect(after.runs).toEqual([]);
    await after.failures.succeeded("chat");
    expect(after.cardIn("chat")).toBeUndefined();
    expect(await after.failures.cards()).toEqual([]);
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

  it("moves a resumed turn to another model too, once in a row", async () => {
    const h = harness(
      { chat: {} },
      { openai: reportOf("available"), anthropic: reportOf("available") },
      { defaultProvider: "openai" },
    );
    const atCapacity: AgentTurnFailure = {
      provider: "openai",
      message: "Selected model is at capacity. Please try a different model.",
    };
    await h.fail("chat", atCapacity);
    await flush();
    expect(h.swaps).toEqual(["chat"]);
    expect(h.runs).toHaveLength(1);
    // The moved model is limited too: now the card.
    await h.fail("chat", atCapacity);
    expect(h.swaps).toEqual(["chat"]);
    expect(h.cardIn("chat")).toMatchObject({ card: "wait", reason: "capacity" });
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

  it("ignores a failure that is neither a provider's nor temporary", async () => {
    const h = harness({ chat: {} }, { anthropic: reportOf("available") });
    await h.fail("chat", { provider: "anthropic", message: "prompt is too long" });
    await flush();
    expect(h.messages.size).toBe(0);
    expect(h.runs).toEqual([]);
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

  it("offers the provider's other model for a model the resolver refused", async () => {
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
    // Learning the time runs nothing: the usage-limit continuation does, after it.
    expect(h.runs).toEqual([]);
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
    // The older turn keeps its card, hidden.
    const parts = [...h.messages.values()].flatMap((m) => m.parts as ProviderFailurePart[]);
    expect(parts.map((part) => part.resolved?.by)).toEqual(["moved", undefined]);
  });

  it("settles a card when a later turn in the chat runs", async () => {
    const h = harness({ chat: {} }, { anthropic: reportOf("usage_limit_reached") });
    await h.fail("chat", quota);
    expect(h.failures.carded("chat")).toBe(true);
    await h.failures.succeeded("chat");
    expect(h.cardIn("chat")?.resolved).toMatchObject({ by: "recovered", continued: true });
    expect(h.failures.carded("chat")).toBe(false);
    expect(h.runs).toEqual([]);
  });

  it("is settled by no system turn of the chat, only by one that answers a person", async () => {
    const h = harness({ chat: {} }, { anthropic: reportOf("usage_limit_reached") });
    await h.fail("chat", quota);
    await h.failures.succeeded("chat", false);
    expect(h.cardIn("chat")?.resolved).toBeUndefined();
    expect(h.failures.carded("chat")).toBe(true);
  });

  it("takes its settled form when a refused send's card settled before its message existed", async () => {
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

describe("a quota reset, through the usage-limit continuation", () => {
  it("settles the card once the continuation's turn succeeds, though it answers no one", async () => {
    const h = harness({ chat: {} }, { anthropic: reportOf("usage_limit_reached") });
    await h.fail("chat", quota);
    // The continuation dispatched the stopped turn, which ran to its end.
    h.failures.continuing("chat");
    await h.failures.succeeded("chat", false);
    expect(h.cardIn("chat")?.resolved).toMatchObject({ by: "recovered", continued: true });
    expect(await h.failures.cards()).toEqual([]);
  });

  it("keeps the card when the continuation's turn fails again", async () => {
    const h = harness({ chat: {} }, { anthropic: reportOf("usage_limit_reached") });
    await h.fail("chat", quota);
    h.failures.continuing("chat");
    await h.fail("chat", quota);
    // A later system turn settles nothing: the failed continuation no longer counts.
    await h.failures.succeeded("chat", false);
    expect(h.shownCards("chat")).toHaveLength(1);
    expect(h.cardIn("chat")?.resolved).toBeUndefined();
  });

  it("resumes nothing by itself when an account reads available again", async () => {
    const reports: ModelAccountReports = {
      anthropic: reportOf("usage_limit_reached"),
      openai: reportOf("available"),
    };
    const h = harness({ chat: {} }, reports);
    await h.fail("chat", quota);
    reports.anthropic = reportOf("available");
    await h.accountChanged("anthropic");
    expect(h.runs).toEqual([]);
    expect(h.cardIn("chat")?.resolved).toBeUndefined();
  });
});

describe("a card's button", () => {
  it("switches this chat only, runs the stopped turn at once, and settles the card", async () => {
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
    // The resumed turn names the provider that could not run it.
    expect(h.runs[0]?.prompt).toContain("because Claude could not run it");
    expect(await h.failures.cards()).toEqual([]);
  });

  it("with Also make default, changes the default and runs only this chat's turn", async () => {
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
    expect(h.chose).toEqual([{ provider: "openai", moveExisting: true }]);
    expect(h.followed).toEqual(["chat"]);
    // Another chat moves on demand, at its next run: its card waits for that.
    expect(h.runs.map((run) => run.threadId)).toEqual(["chat"]);
    expect(h.cardIn("other")?.resolved).toBeUndefined();
  });

  it("leaves the other chats where they are when Move existing chats too is off", async () => {
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
      moveExisting: false,
    });
    expect(h.chose).toEqual([{ provider: "openai", moveExisting: false }]);
  });

  it("moves a model its owner picked to the same strength, still theirs", async () => {
    const chats: Record<string, Row> = {
      chat: { largeModelSelection: "claude-opus-5-5", largeModelSelectionBy: "owner" },
    };
    const h = harness(chats, {
      anthropic: reportOf("usage_limit_reached"),
      openai: reportOf("available"),
    });
    await h.fail("chat", quota);
    const [card] = await h.failures.cards();
    await h.failures.switchCard(card!.messageId, { kind: "provider", provider: "openai" });
    expect(chats.chat).toMatchObject({
      largeModelSelection: "gpt-6-1-sol",
      largeModelSelectionBy: "owner",
    });
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
    await flush();
    expect(chats.chat).toMatchObject({
      largeModelSelection: "gpt-5-6-terra",
      largeModelSelectionBy: "owner",
    });
    expect(h.cardIn("chat")?.resolved).toMatchObject({
      by: "switched",
      model: expect.stringContaining("terra"),
      continued: true,
    });
  });

  it("[Continue] runs the stopped turn where it ran, and settles the card", async () => {
    const h = harness({ chat: {} }, { anthropic: reportOf("available") });
    await h.fail("chat", quota);
    const [card] = await h.failures.cards();
    await h.failures.continueCard(card!.messageId);
    await flush();
    expect(h.runs.map((run) => run.threadId)).toEqual(["chat"]);
    expect(h.kept).toEqual([]);
    expect(h.cardIn("chat")?.resolved).toMatchObject({ by: "recovered", continued: true });
  });

  it("runs the turn once when clicked twice", async () => {
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
    await expect(h.failures.continueCard(card!.messageId)).rejects.toThrow(/settled/);
  });

  it("gives way to a newer message from the guardian, and says the turn did not continue", async () => {
    const queue = held();
    let wrote = false;
    const h = harness(
      { chat: {} },
      { anthropic: reportOf("usage_limit_reached"), openai: reportOf("available") },
      { queue: queue.wait, movedOnSince: () => wrote },
    );
    await h.fail("chat", quota);
    const [card] = await h.failures.cards();
    await h.failures.switchCard(card!.messageId, { kind: "provider", provider: "openai" });
    wrote = true;
    queue.release();
    await flush();
    expect(h.runs).toEqual([]);
    expect(h.cardIn("chat")?.resolved).toMatchObject({ by: "switched", continued: false });
  });

  it("says the turn did not continue when the chat has no session to run in", async () => {
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
    expect(h.cardIn("chat")?.resolved).toHaveProperty("continued", false);
  });

  it("persists nothing: a restart before the turn starts leaves the card open", async () => {
    const queue = held();
    const reports: ModelAccountReports = {
      anthropic: reportOf("usage_limit_reached"),
      openai: reportOf("available"),
    };
    const first = harness({ chat: {} }, reports, { queue: queue.wait });
    await first.fail("chat", quota);
    const [card] = await first.failures.cards();
    await first.failures.switchCard(card!.messageId, { kind: "provider", provider: "openai" });
    first.failures.stop();
    queue.release();
    await flush();
    expect(first.runs).toEqual([]);
    expect(first.cardIn("chat")?.resolved).toBeUndefined();
    // Only the open cards are stored, and a new start runs nothing by itself.
    expect([...first.settings.keys()].sort()).toEqual([PROVIDER_CARDS_SETTING_KEY]);
    const after = harness({ chat: {} }, reports, { settings: first.settings });
    await flush();
    expect(after.runs).toEqual([]);
    expect(await after.failures.cards()).toHaveLength(1);
  });

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
});

describe("a card's options stay as written, and Retry is on every card", () => {
  it("an option that no longer works writes a fresh card with the options that work now", async () => {
    const reports: ModelAccountReports = {
      anthropic: reportOf("usage_limit_reached"),
      openai: reportOf("available"),
    };
    const h = harness({ chat: {} }, reports);
    await h.fail("chat", quota);
    const [card] = await h.failures.cards();
    expect(card?.part.alternatives).toEqual(["openai"]);
    // ChatGPT's login expired after the card was written.
    reports.openai = reportOf("expired");
    expect(
      await h.failures.switchCard(card!.messageId, { kind: "provider", provider: "openai" }),
    ).toBe("refreshed");
    await flush();
    expect(h.runs).toEqual([]);
    expect(h.kept).toEqual([]);
    const shown = h.shownCards("chat");
    expect(shown).toHaveLength(1);
    expect(shown[0]).toMatchObject({ reason: "quota", alternatives: [] });
    const [fresh] = await h.failures.cards();
    expect(fresh?.messageId).not.toBe(card!.messageId);
  });

  it("a stale Use Rome credits writes a fresh card instead of failing", async () => {
    // No balance is left now, whatever the card offered when it was written.
    const h = harness(
      { chat: {} },
      { openai: reportOf("unauthorized"), anthropic: reportOf("unauthorized") },
      { defaultProvider: "anthropic", signedIn: noAccount },
    );
    await h.fail("chat", notLoggedIn);
    const [card] = await h.failures.cards();
    expect(
      await h.failures.switchCard(card!.messageId, { kind: "provider", provider: "rome_credits" }),
    ).toBe("refreshed");
    expect(h.chose).toEqual([]);
    expect(h.shownCards("chat")).toHaveLength(1);
  });

  it("Retry runs an account card's stopped turn too, at once", async () => {
    const h = harness({ chat: {} }, { anthropic: reportOf("unauthorized") });
    await h.fail("chat", notLoggedIn);
    const [card] = await h.failures.cards();
    expect(card?.part.card).toBe("account");
    await h.failures.continueCard(card!.messageId);
    await flush();
    expect(h.runs.map((run) => run.threadId)).toEqual(["chat"]);
    expect(h.cardIn("chat")?.resolved).toMatchObject({ by: "recovered", continued: true });
  });

  it("nothing resumes by itself after a login: the card waits for Retry", async () => {
    const reports: ModelAccountReports = { anthropic: reportOf("unauthorized") };
    const h = harness({ chat: {} }, reports);
    await h.fail("chat", notLoggedIn);
    reports.anthropic = reportOf("available");
    await h.accountChanged("anthropic");
    expect(h.runs).toEqual([]);
    expect(await h.failures.cards()).toHaveLength(1);
  });

  it("a held chat runs on its own account: its ChatGPT card is not Rome credits used up", async () => {
    const h = harness(
      { chat: {} },
      { anthropic: reportOf("unauthorized"), openai: reportOf("unauthorized") },
      { defaultProvider: "rome_credits", signedIn: noAccount, credits: true, held: ["chat"] },
    );
    await h.fail("chat", revoked);
    expect(h.cardIn("chat")).toMatchObject({
      card: "account",
      provider: "openai",
      reason: "removed",
    });
  });

  it("Use Rome credits on a held chat's card lets it follow them", async () => {
    const h = harness(
      { chat: {} },
      { anthropic: reportOf("unauthorized"), openai: reportOf("unauthorized") },
      { defaultProvider: "rome_credits", signedIn: noAccount, credits: true, held: ["chat"] },
    );
    await h.fail("chat", notLoggedIn);
    const [card] = await h.failures.cards();
    await h.failures.switchCard(card!.messageId, { kind: "provider", provider: "rome_credits" });
    expect(h.followed).toEqual(["chat"]);
  });

  it("Use Rome credits on a held owner-picked chat keeps the owner's pick", async () => {
    const chats: Record<string, Row> = {
      chat: { largeModelSelection: "claude-haiku", largeModelSelectionBy: "owner" },
    };
    const h = harness(
      chats,
      { anthropic: reportOf("unauthorized"), openai: reportOf("unauthorized") },
      { defaultProvider: "rome_credits", signedIn: noAccount, credits: true, held: ["chat"] },
    );
    await h.fail("chat", notLoggedIn);
    const [card] = await h.failures.cards();
    await h.failures.switchCard(card!.messageId, { kind: "provider", provider: "rome_credits" });
    expect(h.released).toEqual(["chat"]);
    expect(h.followed).toEqual([]);
    expect(chats.chat).toMatchObject({
      largeModelSelection: "claude-haiku",
      largeModelSelectionBy: "owner",
    });
  });

  it("an error other than a logged-out provider stays an error, not a fresh card", async () => {
    const h = harness(
      { chat: {} },
      { anthropic: reportOf("usage_limit_reached"), openai: reportOf("available") },
    );
    await h.fail("chat", quota);
    const [card] = await h.failures.cards();
    h.failNextChoose(new Error("disk full"));
    await expect(
      h.failures.switchCard(card!.messageId, {
        kind: "provider",
        provider: "openai",
        makeDefault: true,
      }),
    ).rejects.toThrow("disk full");
    expect(h.shownCards("chat")).toHaveLength(1);
  });
});

describe("unattended chats", () => {
  it("cards each task chat and groups them into one notice with one push, informing only", async () => {
    const h = harness(
      { a: { triggerKind: "concierge" }, b: { triggerKind: "concierge" }, main: {} },
      { anthropic: reportOf("usage_limit_reached"), openai: reportOf("available") },
      { credits: true },
    );
    for (const chatId of ["a", "b", "a"]) await h.fail(chatId, quota);
    expect(h.cardIn("a")).toMatchObject({ card: "wait" });
    expect(h.cardIn("b")).toMatchObject({ card: "wait" });
    expect(h.pushes).toEqual([expect.stringMatching(/^Claude quota used up.*\. 1 task waiting$/)]);
    expect(h.notice()).toEqual({
      type: "provider_outage",
      outageId: expect.any(String),
      provider: "anthropic",
      reason: "quota",
      until: expect.any(String),
      card: "wait",
      chatIds: ["a", "b"],
    });
  });

  it("settles the notice once every task's card settled", async () => {
    const h = harness(
      { a: { triggerKind: "concierge" }, b: { triggerKind: "concierge" }, main: {} },
      { anthropic: reportOf("usage_limit_reached"), openai: reportOf("available") },
    );
    await h.fail("a", quota);
    await h.fail("b", quota);
    await h.failures.succeeded("a");
    expect(h.notice()?.resolved).toBeUndefined();
    // Each task's own card acts: a click on b's.
    const card = (await h.failures.cards()).find((open) => open.chatId === "b");
    await h.failures.switchCard(card!.messageId, { kind: "provider", provider: "openai" });
    await flush();
    expect(h.notice()?.resolved).toMatchObject({ by: "switched", provider: "openai" });
    expect(h.settings.get(PROVIDER_OUTAGES_SETTING_KEY)).toEqual([]);
  });

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
    expect(h.notice("main")?.chatIds).toEqual(["mine"]);
    expect(h.notice("main-visitor:acct-v")?.chatIds).toEqual(["theirs"]);
    expect(h.pushes).toHaveLength(1);
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

describe("Rome credits, the instance's choice", () => {
  it("offers Use Rome credits only when no account is logged in and a balance is left", async () => {
    const offered = harness(
      { chat: {} },
      { anthropic: reportOf("unauthorized"), openai: reportOf("unauthorized") },
      { signedIn: noAccount, credits: true },
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
      { signedIn: noAccount, credits: false },
    );
    await empty.fail("chat", notLoggedIn);
    expect(empty.cardIn("chat")?.credits).toBeUndefined();
  });

  it("makes them the default from a card, for every chat, and runs the stopped turn", async () => {
    const chats: Record<string, Row> = {
      a: {},
      b: { largeModelSelection: "claude-opus-5-5", largeModelSelectionBy: "owner" },
    };
    const h = harness(
      chats,
      { openai: reportOf("unauthorized"), anthropic: reportOf("unauthorized") },
      { defaultProvider: "anthropic", signedIn: noAccount, credits: true },
    );
    await h.fail("a", notLoggedIn);
    const [card] = await h.failures.cards();
    await h.failures.switchCard(card!.messageId, { kind: "provider", provider: "rome_credits" });
    await flush();
    expect(h.chose).toEqual([{ provider: "rome_credits", moveExisting: true }]);
    expect(h.defaultProvider()).toBe("rome_credits");
    // No chat is moved one by one: every chat runs on the instance's credits.
    expect(h.kept).toEqual([]);
    expect(h.followed).toEqual([]);
    expect(chats.b).toMatchObject({
      largeModelSelection: "claude-opus-5-5",
      largeModelSelectionBy: "owner",
    });
    expect(h.runs.map((run) => run.threadId)).toEqual(["a"]);
    expect(h.cardIn("a")?.resolved).toMatchObject({
      by: "switched",
      provider: "rome_credits",
      continued: true,
    });
  });

  it("names Rome credits used up, and offers no switch, for any chat while they run", async () => {
    const h = harness(
      { chat: { largeModelSelection: "claude-opus-5-5", largeModelSelectionBy: "owner" } },
      { anthropic: reportOf("unauthorized"), openai: reportOf("unauthorized") },
      { defaultProvider: "rome_credits", signedIn: noAccount, credits: true },
    );
    await h.fail("chat", creditsUsedUp);
    expect(h.cardIn("chat")).toMatchObject({
      card: "account",
      reason: "credits_used_up",
      provider: "rome_credits",
      alternatives: [],
    });
    expect(h.cardIn("chat")?.credits).toBeUndefined();
    // Codex refusing a turn reads as credits used up, not as a ChatGPT logout.
    await h.fail("chat", revoked);
    expect(h.cardIn("chat")).toMatchObject({ provider: "rome_credits", reason: "credits_used_up" });
  });

  it("stop once an account is logged in: the card names ChatGPT again", async () => {
    const signedIn = { ...noAccount };
    const h = harness(
      { chat: {} },
      { openai: reportOf("expired"), anthropic: reportOf("unauthorized") },
      { defaultProvider: "rome_credits", signedIn },
    );
    // A login made ChatGPT the default (design §2, case 1), though the default
    // read here still says credits: the login alone ends them.
    signedIn.openai = true;
    signedIn.rome_credits = false;
    await h.fail("chat", revoked);
    expect(h.cardIn("chat")).toMatchObject({ provider: "openai", reason: "login" });
  });
});

describe("round 9: what a card promises, and who runs its turn", () => {
  it("promises to continue a quota only where the usage-limit continuation will", async () => {
    const taken = new Set(["mine"]);
    const h = harness(
      { mine: {}, visitors: { ownerKey: "visitor:acct-v" } },
      { anthropic: reportOf("usage_limit_reached", {}, "2026-11-21T14:20:00.000Z") },
      { continuesAfterLimit: (chatId) => taken.has(chatId) },
    );
    await h.fail("mine", quota);
    await h.fail("visitors", quota);
    expect(h.cardIn("mine")).toMatchObject({ until: "2026-11-21T14:20:00.000Z", continues: true });
    expect(h.cardIn("visitors")?.until).toBe("2026-11-21T14:20:00.000Z");
    expect(h.cardIn("visitors")?.continues).toBeUndefined();
  });

  it("decides a refused send's promise once its message is written", async () => {
    let stored = false;
    const h = harness(
      { chat: {} },
      { anthropic: reportOf("usage_limit_reached", {}, "2026-11-21T14:20:00.000Z") },
      { continuesAfterLimit: () => stored },
    );
    const part = await h.failures.cardFor(
      { chatId: "chat", agentName: "main", failure: refused("anthropic", "quota_exhausted") },
      "sent",
      [],
    );
    expect(part?.continues).toBeUndefined();
    h.messages.set("sent", { chatId: "chat", parts: [part] });
    stored = true;
    await h.failures.written("sent");
    expect(h.cardIn("chat")?.continues).toBe(true);
  });

  it("refuses a click while the usage-limit continuation runs the chat", async () => {
    const h = harness({ chat: {} }, { anthropic: reportOf("available") });
    await h.fail("chat", quota);
    const [card] = await h.failures.cards();
    h.failures.continuing("chat");
    await expect(h.failures.continueCard(card!.messageId)).rejects.toThrow(/already continuing/);
    await expect(
      h.failures.switchCard(card!.messageId, { kind: "provider", provider: "openai" }),
    ).rejects.toThrow(/already continuing/);
    await flush();
    expect(h.runs).toEqual([]);
  });

  it("steps aside when the continuation reached the chat while a click waited in the queue", async () => {
    const queue = held();
    const h = harness({ chat: {} }, { anthropic: reportOf("available") }, { queue: queue.wait });
    await h.fail("chat", quota);
    const [card] = await h.failures.cards();
    await h.failures.continueCard(card!.messageId);
    h.failures.continuing("chat");
    queue.release();
    await flush();
    expect(h.runs).toEqual([]);
    // The continuation's own outcome settles the card.
    expect(h.cardIn("chat")?.resolved).toBeUndefined();
    await h.failures.succeeded("chat", false);
    expect(h.cardIn("chat")?.resolved).toMatchObject({ by: "recovered", continued: true });
  });

  it("runs nothing when the continuation ran and settled the card while a click waited", async () => {
    const queue = held();
    const h = harness({ chat: {} }, { anthropic: reportOf("available") }, { queue: queue.wait });
    await h.fail("chat", quota);
    const [card] = await h.failures.cards();
    // Clicked before the continuation took the chat, queued behind it.
    await h.failures.continueCard(card!.messageId);
    h.failures.continuing("chat");
    await h.failures.succeeded("chat", false);
    queue.release();
    await flush();
    expect(h.runs).toEqual([]);
    expect(h.cardIn("chat")?.resolved).toMatchObject({ by: "recovered", continued: true });
  });

  it("[Retry] runs a final temporary failure's turn at once", async () => {
    const h = harness({ chat: {} }, { anthropic: reportOf("available") });
    await h.fail("chat", temporary, true);
    const [card] = await h.failures.cards();
    await h.failures.continueCard(card!.messageId);
    await flush();
    expect(h.runs.map((run) => run.threadId)).toEqual(["chat"]);
    expect(h.cardIn("chat")?.resolved).toMatchObject({ by: "recovered", continued: true });
  });

  it("leaves the Concierge's own retry to the Concierge: one owner writes its final card", async () => {
    const h = harness({ main: { agentName: "concierge" } }, { anthropic: reportOf("available") });
    // The first failure, and the Concierge's retry failing, each heard by the generic path.
    await h.fail("main", temporary);
    await h.fail("main", temporary);
    expect(await h.failures.cards()).toEqual([]);
    expect(h.messages.size).toBe(0);
    // The Concierge's retry succeeded: no hidden card was left behind.
    await h.failures.succeeded("main", false);
    expect(h.failures.carded("main")).toBe(false);
    // What it could not get past it hands over, final: the one card.
    await h.fail("main", temporary, true);
    expect(h.shownCards("main")).toEqual([
      expect.objectContaining({ card: "wait", reason: "temporary" }),
    ]);
  });

  it("forgets an interrupted continuation: a later system turn settles nothing", async () => {
    const h = harness({ chat: {} }, { anthropic: reportOf("usage_limit_reached") });
    await h.fail("chat", quota);
    h.failures.continuing("chat");
    h.failures.interrupted("chat");
    await h.failures.succeeded("chat", false);
    expect(h.cardIn("chat")?.resolved).toBeUndefined();
    expect(h.failures.carded("chat")).toBe(true);
  });
});
