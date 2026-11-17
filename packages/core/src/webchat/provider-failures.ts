// What a dashboard chat shows when the provider its turn needed cannot run.
// Rome never moves a chat to another provider on its own: a temporary error
// gets one silent retry, and anything else (a usage limit, a lost sign-in, a
// removed provider) shows a card in the chat with what the guardian can do.
// Unattended chats (task chats) do not card each chat: their failures gather
// into one notice per provider outage in the Concierge main chat, with one
// push, and they resume on their own when the provider runs again.
// docs/domains/agents.md#default-provider

import type { AgentTurnFailure } from "@rome-os/app-runtime";
import type {
  DefaultModelProvider,
  ProviderFailurePart,
  ProviderOutagePart,
} from "@rome/api-types/chat";
import { v7 as uuidv7 } from "uuid";
import {
  failoverReason,
  type AccountedProviderId,
  type DefaultProvider,
  type DefaultProviders,
  type ModelAccounts,
  type ModelResolutionErrorPayload,
  type SignedInProviders,
} from "../agent/index.js";
import type { SettingsRepository } from "../db/repositories/settings.js";
import { createLogger } from "../logger.js";
import { isConciergeChat, TASK_CHAT_TRIGGER_KIND } from "./privacy.js";
import type { WebChatRepository } from "./repository.js";
import type { ContinuationRunner } from "./restart-continuation.js";

const log = createLogger("provider-failures");

/** The stored name of the outages that hold unattended chats. */
export const PROVIDER_OUTAGES_SETTING_KEY = "providerOutages";

/** How long a temporary failure waits before its one retry. */
const RETRY_DELAY_MS = 30_000;
const RETRY_MARKER = "<provider_retry>";

const PROVIDER_NAMES: Record<DefaultModelProvider, string> = {
  anthropic: "Claude",
  openai: "Codex (ChatGPT)",
  rome_credits: "Rome credits",
};

export function providerName(provider: DefaultModelProvider): string {
  return PROVIDER_NAMES[provider];
}

/** One outage that holds unattended chats, as stored. */
export interface ProviderOutage {
  id: string;
  provider: DefaultModelProvider;
  reason: ProviderFailurePart["reason"];
  until?: string;
  /** The Concierge main chat and the notice in it. */
  noticeChatId: string;
  noticeMessageId: string;
  /** The chats waiting, with the agent and runtime session to resume. */
  chats: Array<{ chatId: string; agentName: string; sessionId: string }>;
  since: string;
}

/** A failure as the chat side reads it. */
export interface ChatTurnFailure {
  chatId: string;
  agentName: string;
  /** The runtime session the turn ran in, when one opened. */
  sessionId?: string;
  /** The failed turn, so the card shows with it. */
  turnId?: string;
  /** A failed turn, or a turn the model resolver refused before it ran. */
  failure:
    | { kind: "turn"; failure: AgentTurnFailure }
    | { kind: "resolution"; payload: ModelResolutionErrorPayload };
}

export interface ProviderFailuresDeps {
  accounts: Pick<ModelAccounts, "read" | "onChanged">;
  defaults: Pick<DefaultProviders, "current" | "signedIn">;
  webchatRepo: Pick<WebChatRepository, "getSession" | "addBackendMessage" | "updateMessageContent">;
  settings: Pick<SettingsRepository, "get" | "set">;
  /** The guardian's Concierge main chat, or null when it does not exist. */
  mainChatId: () => Promise<string | null>;
  /** The runtime session of a chat's agent, for a turn that never opened one. */
  runtimeOf: (chatId: string, agentName: string) => Promise<string | null>;
  runner: ContinuationRunner;
  /** Pushes to the guardian's phone. Absent, nothing is pushed. */
  notify?: {
    send(content: {
      body: string;
      level?: "active" | "passive";
      chatId?: string;
    }): Promise<unknown>;
  };
  delay?: (ms: number) => Promise<void>;
  now?: () => Date;
}

type Classified =
  | { kind: "temporary" }
  | {
      kind: "card";
      provider: AccountedProviderId;
      reason: ProviderFailurePart["reason"];
      until?: string;
    };

export interface ProviderFailures {
  /** Decides what a failed turn in a dashboard chat shows, writing the card itself. */
  failed(turn: ChatTurnFailure): Promise<void>;
  /**
   * For a turn the resolver refused before it ran, whose error message the
   * caller writes: the card to write beside the error, or null when the chat
   * shows none (unattended chats join the outage notice instead).
   */
  cardFor(turn: ChatTurnFailure): Promise<ProviderFailurePart | null>;
  /** Runs the chat's stopped request again, as the card's actions do after a change. */
  resend(chatId: string, agentName: string, providerOverride?: AccountedProviderId): Promise<void>;
  /** The guardian ran an outage's waiting chats on `provider` now, for one turn each. */
  runOutageOn(outageId: string, provider: AccountedProviderId): Promise<number>;
  outages(): Promise<ProviderOutage[]>;
  stop(): void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function retryPrompt(provider: string): string {
  return (
    `${RETRY_MARKER}The previous request in this chat did not run because ${provider} could not run it. ` +
    "It can run now. Read this chat's history to see what was asked. " +
    "Check the actual state of the work and verify anything uncertain. Do only what remains. " +
    "If a side-effecting action cannot be confirmed, ask the guardian rather than redo it." +
    "</provider_retry>"
  );
}

export function createProviderFailures(deps: ProviderFailuresDeps): ProviderFailures {
  const now = deps.now ?? (() => new Date());
  const delay = deps.delay ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  let stopped = false;
  // Chats whose one silent retry is running: its failure is never retried.
  const retrying = new Set<string>();
  // Outage writes, one at a time.
  let queue: Promise<unknown> = Promise.resolve();
  const serial = <T>(work: () => Promise<T>): Promise<T> => {
    const next = queue.then(work, work);
    queue = next.catch(() => undefined);
    return next;
  };

  const readOutages = async (): Promise<ProviderOutage[]> => {
    const value = await deps.settings.get<unknown>(PROVIDER_OUTAGES_SETTING_KEY);
    return Array.isArray(value) ? (value.filter(isRecord) as unknown as ProviderOutage[]) : [];
  };
  const writeOutages = (outages: ProviderOutage[]) =>
    deps.settings.set(PROVIDER_OUTAGES_SETTING_KEY, outages);

  /** The provider as the guardian names it: Codex on Rome credits reads as Rome credits. */
  const named = (provider: AccountedProviderId): DefaultModelProvider => {
    const current = deps.defaults.current();
    return provider === "openai" && current === "rome_credits" ? "rome_credits" : provider;
  };

  /** Signed-in providers other than `failing` that can run now. */
  const alternatives = (failing: DefaultModelProvider): DefaultModelProvider[] => {
    const signedIn: SignedInProviders = deps.defaults.signedIn();
    const reports = deps.accounts.read();
    const runs = (provider: DefaultProvider) =>
      provider === "rome_credits"
        ? signedIn.rome_credits
        : reports[provider]?.state === "available";
    return (["anthropic", "openai", "rome_credits"] as const).filter(
      (provider) => provider !== failing && signedIn[provider] && runs(provider),
    );
  };

  const reasonFromState = (provider: AccountedProviderId): "login" | "removed" =>
    deps.accounts.read()[provider]?.state === "expired" ? "login" : "removed";

  const classify = (failure: ChatTurnFailure["failure"]): Classified | null => {
    if (failure.kind === "resolution") {
      const { payload } = failure;
      if (payload.code === "model_unavailable") return null;
      const provider =
        payload.provider ??
        (() => {
          const current = deps.defaults.current();
          return current === "anthropic" ? "anthropic" : current ? "openai" : null;
        })();
      if (!provider) return null;
      return payload.reason === "quota_exhausted"
        ? {
            kind: "card",
            provider,
            reason: "quota",
            ...(payload.usageLimitUntil ? { until: payload.usageLimitUntil } : {}),
          }
        : { kind: "card", provider, reason: reasonFromState(provider) };
    }
    const reason = failoverReason(failure.failure, deps.accounts.read());
    const provider = failure.failure.provider;
    if (provider !== "anthropic" && provider !== "openai") return null;
    if (reason === "temporary") return { kind: "temporary" };
    if (reason === "quota") {
      const until = deps.accounts.read()[provider]?.usageLimitUntil;
      return { kind: "card", provider, reason: "quota", ...(until ? { until } : {}) };
    }
    if (reason === "login") return { kind: "card", provider, reason: reasonFromState(provider) };
    return null;
  };

  const sessionOf = async (turn: Pick<ChatTurnFailure, "chatId" | "agentName" | "sessionId">) =>
    turn.sessionId ?? (await deps.runtimeOf(turn.chatId, turn.agentName));

  const resend: ProviderFailures["resend"] = async (chatId, agentName, providerOverride) => {
    const sessionId = await deps.runtimeOf(chatId, agentName);
    if (!sessionId) throw new Error("This chat has no session to resend in");
    const name = providerOverride ? providerName(providerOverride) : "the provider";
    void deps.runner
      .runAndReport(
        {
          agentName,
          sessionId,
          channel: "webchat",
          threadId: chatId,
          prompt: retryPrompt(name),
        },
        {
          inputLabel: "Provider recovery",
          ...(providerOverride ? { providerOverride } : {}),
        },
      )
      .catch((error: unknown) =>
        log.warn("provider recovery turn failed", { chatId, error: String(error) }),
      );
  };

  const retryOnce = async (turn: ChatTurnFailure): Promise<void> => {
    const sessionId = await sessionOf(turn);
    if (!sessionId) return;
    retrying.add(turn.chatId);
    try {
      await delay(RETRY_DELAY_MS);
      if (stopped) return;
      await deps.runner.runAndReport(
        {
          agentName: turn.agentName,
          sessionId,
          channel: "webchat",
          threadId: turn.chatId,
          prompt: retryPrompt("the provider"),
        },
        { inputLabel: "Provider recovery" },
      );
    } finally {
      retrying.delete(turn.chatId);
    }
  };

  const cardPart = async (
    turn: ChatTurnFailure,
    failed: Extract<Classified, { kind: "card" }>,
  ): Promise<ProviderFailurePart | null> => {
    const chat = await deps.webchatRepo.getSession(turn.chatId);
    if (!chat) return null;
    const provider = named(failed.provider);
    const part: ProviderFailurePart = {
      type: "provider_failure",
      provider,
      reason: failed.reason,
      ...(failed.until ? { until: failed.until } : {}),
      followsDefault: !chat.largeModelSelection || chat.largeModelSelectionBy === "auto",
      alternatives: alternatives(provider),
      chatId: turn.chatId,
    };
    return part;
  };

  const cardIn = async (turn: ChatTurnFailure, failed: Extract<Classified, { kind: "card" }>) => {
    const part = await cardPart(turn, failed);
    if (part)
      await deps.webchatRepo.addBackendMessage(turn.chatId, turn.turnId ?? uuidv7(), [part]);
  };

  const noticePart = (outage: ProviderOutage, resolvedAt?: string): ProviderOutagePart => ({
    type: "provider_outage",
    outageId: outage.id,
    provider: outage.provider,
    reason: outage.reason,
    ...(outage.until ? { until: outage.until } : {}),
    chatIds: outage.chats.map((chat) => chat.chatId),
    alternatives: alternatives(outage.provider),
    ...(resolvedAt ? { resolvedAt } : {}),
  });

  const pushText = (outage: ProviderOutage): string => {
    const name = providerName(outage.provider);
    const cause =
      outage.reason === "quota"
        ? `${name} usage limit reached${outage.until ? ` (back at ${new Date(outage.until).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })})` : ""}`
        : outage.reason === "login"
          ? `${name} needs signing in again`
          : `${name} is not signed in`;
    const count = outage.chats.length;
    return `${cause}, ${count} ${count === 1 ? "chat" : "chats"} waiting`;
  };

  const groupIn = (turn: ChatTurnFailure, failed: Extract<Classified, { kind: "card" }>) =>
    serial(async () => {
      const sessionId = await sessionOf(turn);
      if (!sessionId) return;
      const provider = named(failed.provider);
      const outages = await readOutages();
      const open = outages.find((outage) => outage.provider === provider);
      if (open) {
        if (open.chats.some((chat) => chat.chatId === turn.chatId)) return;
        open.chats.push({ chatId: turn.chatId, agentName: turn.agentName, sessionId });
        await writeOutages(outages);
        await deps.webchatRepo.updateMessageContent(
          open.noticeMessageId,
          JSON.stringify([noticePart(open)]),
        );
        return;
      }
      const noticeChatId = await deps.mainChatId();
      if (!noticeChatId) return;
      const outage: ProviderOutage = {
        id: uuidv7(),
        provider,
        reason: failed.reason,
        ...(failed.until ? { until: failed.until } : {}),
        noticeChatId,
        noticeMessageId: "",
        chats: [{ chatId: turn.chatId, agentName: turn.agentName, sessionId }],
        since: now().toISOString(),
      };
      const message = await deps.webchatRepo.addBackendMessage(noticeChatId, uuidv7(), [
        noticePart(outage),
      ]);
      outage.noticeMessageId = message.id;
      await writeOutages([...outages, outage]);
      await deps.notify
        ?.send({ body: pushText(outage), level: "active", chatId: noticeChatId })
        .catch((error: unknown) =>
          log.warn("provider outage push failed", { error: String(error) }),
        );
    });

  /** An outage ends: the provider runs again, or the guardian ran its chats elsewhere. */
  const resolve = (match: (outage: ProviderOutage) => boolean) =>
    serial(async () => {
      const outages = await readOutages();
      const ended = outages.filter(match);
      if (ended.length === 0) return [];
      await writeOutages(outages.filter((outage) => !match(outage)));
      const at = now().toISOString();
      for (const outage of ended) {
        await deps.webchatRepo
          .updateMessageContent(outage.noticeMessageId, JSON.stringify([noticePart(outage, at)]))
          .catch(() => undefined);
      }
      return ended;
    });

  const unsubscribe = deps.accounts.onChanged((provider, change, succeeded) => {
    if (change !== "refreshed" || succeeded === false) return;
    if (provider !== "anthropic" && provider !== "openai") return;
    if (deps.accounts.read()[provider]?.state !== "available") return;
    // The usage-limit continuation resumes the waiting chats themselves.
    void resolve(
      (outage) => (outage.provider === "anthropic" ? "anthropic" : "openai") === provider,
    );
  });

  return {
    async failed(turn) {
      if (stopped) return;
      const classified = classify(turn.failure);
      if (!classified) return;
      const chat = await deps.webchatRepo.getSession(turn.chatId);
      if (!chat) return;
      if (classified.kind === "temporary") {
        // The Concierge retries its own chats; a retry is never retried.
        if (isConciergeChat(chat) || retrying.has(turn.chatId)) return;
        await retryOnce(turn);
        return;
      }
      if (chat.triggerKind === TASK_CHAT_TRIGGER_KIND) await groupIn(turn, classified);
      else await cardIn(turn, classified);
    },
    async cardFor(turn) {
      if (stopped) return null;
      const classified = classify(turn.failure);
      if (classified?.kind !== "card") return null;
      const chat = await deps.webchatRepo.getSession(turn.chatId);
      if (!chat) return null;
      if (chat.triggerKind === TASK_CHAT_TRIGGER_KIND) {
        await groupIn(turn, classified);
        return null;
      }
      return cardPart(turn, classified);
    },
    resend,
    async runOutageOn(outageId, provider) {
      const [outage] = await resolve((candidate) => candidate.id === outageId);
      if (!outage) return 0;
      for (const chat of outage.chats) await resend(chat.chatId, chat.agentName, provider);
      return outage.chats.length;
    },
    outages: readOutages,
    stop() {
      stopped = true;
      unsubscribe();
    },
  };
}
