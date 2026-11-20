// What a dashboard chat shows when the provider its turn needed cannot run.
// Rome never moves a chat to another provider on its own. It recovers by
// itself only when no context is lost, no money is spent and nobody's pick is
// overridden: a temporary error gets one silent retry, and a single model's
// limit moves a chat that follows the default to another model of the same
// provider, with a note. Anything else shows one of three cards, by what the
// guardian has to do: wait (it recovers by itself), fix the account, or change
// the model. A card settles in place, to one line, and the stopped turn runs
// again by itself. Unattended chats (task chats, scheduled runs, routines) get
// their card too, and the Concierge main chat gets one notice per incident,
// with one push. docs/domains/agents.md#provider-failure

import type { AgentTurnFailure } from "@rome-os/app-runtime";
import type {
  DefaultModelProvider,
  ProviderFailureCardKind,
  ProviderFailurePart,
  ProviderFailureResolution,
  ProviderOutagePart,
} from "@rome/api-types/chat";
import { v7 as uuidv7 } from "uuid";
import {
  isModelSelectionId,
  MODEL_SELECTIONS,
  providerFailureReason,
  providerOfDefault,
  sameProviderTarget,
  selectionOfStrength,
  strengthOfSelection,
  type AccountedProviderId,
  type DefaultProvider,
  type DefaultProviders,
  type ModelAccounts,
  type ModelResolutionErrorPayload,
  type ProviderFailureReason,
} from "../agent/index.js";
import type { SettingsRepository } from "../db/repositories/settings.js";
import { createLogger } from "../logger.js";
import type { ChatProviders } from "./chat-providers.js";
import { isConciergeChat, TASK_CHAT_TRIGGER_KIND } from "./privacy.js";
import type { WebChatRepository } from "./repository.js";
import type { ContinuationRunner } from "./restart-continuation.js";

const log = createLogger("provider-failures");

/** The stored incidents that stopped unattended chats. */
export const PROVIDER_OUTAGES_SETTING_KEY = "providerOutages";
/** The stored cards not settled yet. */
export const PROVIDER_CARDS_SETTING_KEY = "providerCards";

/** How long a temporary failure waits before its one silent retry. */
const RETRY_DELAY_MS = 30_000;
/** When a card that recovers by itself tries the stopped turn again, after it showed. */
const RECOVERY_DELAYS_MS = [5 * 60_000, 15 * 60_000, 30 * 60_000];
const RETRY_MARKER = "<provider_retry>";

const PROVIDER_NAMES: Record<DefaultModelProvider, string> = {
  anthropic: "Claude",
  openai: "ChatGPT",
  rome_credits: "Rome credits",
};

function providerName(provider: DefaultModelProvider): string {
  return PROVIDER_NAMES[provider];
}

/** The card a reason shows: what the guardian has to do. */
function cardKindOf(reason: ProviderFailureReason): ProviderFailureCardKind {
  switch (reason) {
    case "quota":
    case "temporary":
    case "capacity":
      return "wait";
    case "model_unavailable":
      return "model";
    default:
      return "account";
  }
}

/** A card not settled yet, as stored. */
export interface OpenProviderCard {
  messageId: string;
  chatId: string;
  agentName: string;
  /** The provider that failed, as Rome runs it. */
  runsOn: AccountedProviderId;
  part: ProviderFailurePart;
  /** Parts written beside the card in its message, kept when it is rewritten. */
  beside: unknown[];
  since: string;
  /** How many times Rome ran the stopped turn again for a card that recovers by itself. */
  attempts: number;
  /**
   * What the provider's account read when the card showed. Only a read that
   * then turns available settles the card: an account billed per use reads
   * available throughout, so its card waits for the guardian or a later turn.
   */
  stateAtFailure?: string;
}

/** One incident that stopped unattended chats, as stored. */
export interface ProviderOutage {
  id: string;
  provider: DefaultModelProvider;
  runsOn: AccountedProviderId;
  reason: ProviderFailureReason;
  until?: string;
  /** The Concierge main chat and the notice in it. */
  noticeChatId: string;
  noticeMessageId: string;
  /** The chats stopped, with the agent to resume. */
  chats: Array<{ chatId: string; agentName: string }>;
  since: string;
  /** The notice as last written. */
  part?: ProviderOutagePart;
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

/** What a card's or a notice's switch does. */
export type ProviderSwitch =
  | { kind: "provider"; provider: DefaultProvider; makeDefault?: boolean }
  | { kind: "model"; selection: string };

export interface ProviderFailuresDeps {
  /** `refresh`, when given, reads a provider's account again, as for a reset time a card lacks. */
  accounts: Pick<ModelAccounts, "read" | "onChanged"> & Partial<Pick<ModelAccounts, "refresh">>;
  defaults: Pick<DefaultProviders, "current" | "signedIn" | "choose" | "onChanged">;
  chats: Pick<ChatProviders, "keep" | "follow">;
  webchatRepo: Pick<
    WebChatRepository,
    "getSession" | "addBackendMessage" | "updateMessageContent" | "updateSessionLargeModelSelection"
  >;
  settings: Pick<SettingsRepository, "get" | "set">;
  /** The guardian's Concierge main chat, or null when it does not exist. */
  mainChatId: () => Promise<string | null>;
  /** The runtime session of a chat's agent, opening one when the chat has none. */
  runtimeOf: (chatId: string, agentName: string) => Promise<string | null>;
  runner: ContinuationRunner;
  /**
   * Moves a chat that follows the default to another model of the same
   * provider after a single model's limit, with its note. Null when there is
   * none to move to, or the chat's owner picked its model.
   */
  swapModel?: (chatId: string, agentName: string, failure: AgentTurnFailure) => Promise<unknown>;
  /** Rome credits can be spent now: linked, enabled and with a balance. */
  creditsUsable?: () => boolean;
  /** Tells a live session of the chat the model its next turn runs. */
  selectModel?: (chatId: string, agentName: string, selection: string) => void;
  /** An agent's canonical id ("core:main") for the name a chat uses ("main"). */
  canonicalAgent?: (agentName: string) => string;
  /** Pushes to the guardian's phone. Absent, nothing is pushed. */
  notify?: {
    send(content: {
      body: string;
      level?: "active" | "passive";
      chatId?: string;
    }): Promise<unknown>;
  };
  delay?: (ms: number) => Promise<void>;
  /** Runs `work` after `ms`, for a card that recovers by itself. Returns what cancels it. */
  later?: (ms: number, work: () => void) => () => void;
  now?: () => Date;
}

export interface ProviderFailures {
  /**
   * Decides what a failed turn in a dashboard chat does, writing any card
   * itself. `final` marks a failure a recovery already tried to get past.
   */
  failed(turn: ChatTurnFailure, options?: { final?: boolean }): Promise<void>;
  /**
   * For a turn the resolver refused before it ran, whose message the caller
   * writes with id `messageId`: the card to write in it beside `beside`, or
   * null when the chat shows none.
   */
  cardFor(
    turn: ChatTurnFailure,
    messageId: string,
    beside: unknown[],
  ): Promise<ProviderFailurePart | null>;
  /** A turn in the chat ran: its open card, if any, has recovered. */
  succeeded(chatId: string): Promise<void>;
  /** A card's switch: this chat moves, its card settles, and the stopped turn runs again. */
  switchCard(messageId: string, change: ProviderSwitch): Promise<void>;
  /** A notice's switch: every chat it stopped moves at once. Returns how many. */
  switchOutage(outageId: string, change: ProviderSwitch): Promise<number>;
  /** Runs the chat's stopped request again. */
  resend(chatId: string, agentName: string): Promise<void>;
  /** Whether the chat has a card not settled yet: its card resumes it, nothing else. */
  carded(chatId: string): boolean;
  cards(): Promise<OpenProviderCard[]>;
  outages(): Promise<ProviderOutage[]>;
  stop(): void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function retryPrompt(provider: string): string {
  return (
    `${RETRY_MARKER}The previous request in this chat did not run because ${provider} could not run it. ` +
    "It can run now. Read this chat's history to see what was asked. " +
    "Check the actual state of the work and verify anything uncertain. Do only what remains. " +
    "If a side-effecting action cannot be confirmed, ask the guardian rather than redo it." +
    "</provider_retry>"
  );
}

function clock(time: string): string {
  return new Date(time).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

/** The push for an incident: what stopped and how many tasks wait. */
export function outagePushText(
  outage: Pick<ProviderOutage, "provider" | "reason" | "until" | "chats">,
): string {
  const name = providerName(outage.provider);
  const cause = (() => {
    switch (outage.reason) {
      case "quota":
        return `${name} quota used up${outage.until ? `, continues at ${clock(outage.until)}` : ""}`;
      case "temporary":
      case "capacity":
        return `${name} is unavailable for now`;
      case "model_unavailable":
        return `The ${name} model is unavailable`;
      case "login":
        return `${name} needs you to log in again`;
      case "removed":
        return `${name} is not logged in`;
      case "credits_used_up":
        return `${name} has no credits left`;
      case "spend_cap":
        return `${name} reached its spending limit`;
    }
  })();
  const count = outage.chats.length;
  return `${cause}. ${count} ${count === 1 ? "task" : "tasks"} waiting`;
}

export function createProviderFailures(deps: ProviderFailuresDeps): ProviderFailures {
  const now = deps.now ?? (() => new Date());
  const delay = deps.delay ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const later =
    deps.later ??
    ((ms: number, work: () => void) => {
      const timer = setTimeout(work, ms);
      timer.unref?.();
      return () => clearTimeout(timer);
    });
  let stopped = false;
  // Chats whose recovery turn is running: its failure is final.
  const recovering = new Set<string>();
  // Chats with a card not settled, kept in memory so the usage-limit
  // continuation can ask synchronously.
  const cardedChats = new Set<string>();
  const scheduled = new Map<string, () => void>();
  // Chats a switch is moving: a default change it makes leaves them to it.
  const switching = new Set<string>();
  // Writes to the stored cards and incidents, one at a time.
  let queue: Promise<unknown> = Promise.resolve();
  const serial = <T>(work: () => Promise<T>): Promise<T> => {
    const next = queue.then(work, work);
    queue = next.catch(() => undefined);
    return next;
  };

  const readList = async <T>(key: string): Promise<T[]> => {
    const value = await deps.settings.get<unknown>(key);
    return Array.isArray(value) ? (value.filter(isRecord) as unknown as T[]) : [];
  };
  const readCards = () => readList<OpenProviderCard>(PROVIDER_CARDS_SETTING_KEY);
  const writeCards = async (cards: OpenProviderCard[]) => {
    await deps.settings.set(PROVIDER_CARDS_SETTING_KEY, cards);
    cardedChats.clear();
    for (const card of cards) cardedChats.add(card.chatId);
  };
  const readOutages = () => readList<ProviderOutage>(PROVIDER_OUTAGES_SETTING_KEY);
  const writeOutages = (outages: ProviderOutage[]) =>
    deps.settings.set(PROVIDER_OUTAGES_SETTING_KEY, outages);

  /** The provider as the guardian names it: Codex on Rome credits reads as Rome credits. */
  const named = (provider: AccountedProviderId): DefaultModelProvider => {
    if (provider !== "openai") return provider;
    const signedIn = deps.defaults.signedIn();
    return !signedIn.openai && !signedIn.anthropic && deps.creditsUsable?.()
      ? "rome_credits"
      : "openai";
  };

  /** The guardian's other logged-in accounts that can run now. */
  const alternatives = (failing: AccountedProviderId): DefaultModelProvider[] => {
    const reports = deps.accounts.read();
    return (["anthropic", "openai"] as const).filter(
      (provider) => provider !== failing && reports[provider]?.state === "available",
    );
  };

  /** "Use Rome credits": only while no AI account is logged in and a balance is left. */
  const creditsOffered = (): boolean => {
    const signedIn = deps.defaults.signedIn();
    return !signedIn.anthropic && !signedIn.openai && deps.creditsUsable?.() === true;
  };

  interface Classified {
    provider: AccountedProviderId;
    reason: ProviderFailureReason;
    until?: string;
    model?: string;
    detail?: string;
    failure?: AgentTurnFailure;
  }

  const classify = (failure: ChatTurnFailure["failure"]): Classified | null => {
    const reports = deps.accounts.read();
    if (failure.kind === "resolution") {
      const { payload } = failure;
      const provider =
        payload.provider ??
        (() => {
          const current = deps.defaults.current();
          return current ? providerOfDefault(current) : null;
        })();
      if (!provider) return null;
      if (payload.code === "model_unavailable") {
        return { provider, reason: "model_unavailable", detail: payload.error };
      }
      if (payload.reason === "quota_exhausted") {
        const until = payload.usageLimitUntil ?? reports[provider]?.usageLimitUntil;
        return { provider, reason: "quota", detail: payload.error, ...(until ? { until } : {}) };
      }
      const state = reports[provider]?.state;
      return {
        provider,
        reason: state === "expired" ? "login" : "removed",
        detail: payload.error,
      };
    }
    const reason = providerFailureReason(failure.failure, reports);
    const provider = failure.failure.provider;
    if (!reason || (provider !== "anthropic" && provider !== "openai")) return null;
    const until = reason === "quota" ? reports[provider]?.usageLimitUntil : undefined;
    return {
      provider,
      reason,
      detail: failure.failure.message,
      failure: failure.failure,
      ...(until ? { until } : {}),
    };
  };

  const ownerPicked = (chat: {
    largeModelSelection: string | null;
    largeModelSelectionBy?: string | null;
  }) =>
    chat.largeModelSelectionBy === "owner" ||
    (chat.largeModelSelection !== null && !chat.largeModelSelectionBy);

  const run = async (chatId: string, agentName: string, provider: string): Promise<void> => {
    const sessionId = await deps.runtimeOf(chatId, agentName);
    if (!sessionId) throw new Error("This chat has no session to run in");
    recovering.add(chatId);
    try {
      await deps.runner.runAndReport(
        {
          agentName,
          sessionId,
          channel: "webchat",
          threadId: chatId,
          prompt: retryPrompt(provider),
        },
        { inputLabel: "Provider recovery" },
      );
    } finally {
      recovering.delete(chatId);
    }
  };

  /** Runs the stopped turn again without waiting for it. */
  const resume = (chatId: string, agentName: string, provider: string) => {
    void run(chatId, agentName, provider).catch((error: unknown) =>
      log.warn("provider recovery turn failed", { chatId, error: String(error) }),
    );
  };

  const cardPart = async (
    chatId: string,
    agentName: string,
    failed: Classified,
  ): Promise<ProviderFailurePart | null> => {
    const chat = await deps.webchatRepo.getSession(chatId);
    if (!chat) return null;
    const card = cardKindOf(failed.reason);
    const replacement =
      card === "model" && failed.model
        ? sameProviderTarget(deps.accounts.read(), failed.provider, failed.model)
        : null;
    const model =
      failed.model ??
      (isModelSelectionId(chat.largeModelSelection)
        ? MODEL_SELECTIONS[chat.largeModelSelection].model
        : undefined);
    const credits = card === "account" && creditsOffered();
    return {
      type: "provider_failure",
      provider: named(failed.provider),
      reason: failed.reason,
      ...(failed.until ? { until: failed.until } : {}),
      followsDefault: !ownerPicked(chat),
      alternatives: card === "model" ? [] : alternatives(failed.provider),
      chatId,
      card,
      agentName,
      ...(model ? { model } : {}),
      ...(replacement
        ? {
            replacement: {
              selection: replacement.selectionId,
              model: MODEL_SELECTIONS[replacement.selectionId].model,
            },
          }
        : {}),
      ...(credits ? { credits: true } : {}),
      ...(failed.detail ? { detail: failed.detail.slice(0, 2_000) } : {}),
    };
  };

  const content = (card: Pick<OpenProviderCard, "beside" | "part">) =>
    JSON.stringify([...card.beside, card.part]);

  /**
   * Writes a chat's open card with the turn that failed. A chat shows one open
   * card: an older one leaves its message, which keeps what else it held, and
   * the new card carries on its recovery attempts.
   */
  const writeCard = (
    turn: ChatTurnFailure,
    part: ProviderFailurePart,
    runsOn: AccountedProviderId,
    written?: { messageId: string; beside: unknown[] },
  ) =>
    serial(async () => {
      const cards = await readCards();
      const open = cards.find((card) => card.chatId === turn.chatId);
      if (open) {
        await deps.webchatRepo
          .updateMessageContent(open.messageId, JSON.stringify(open.beside))
          .catch(() => undefined);
      }
      let messageId = written?.messageId;
      if (!messageId) {
        const message = await deps.webchatRepo.addBackendMessage(
          turn.chatId,
          turn.turnId ?? uuidv7(),
          [part],
        );
        messageId = message.id;
      }
      const rest = cards.filter((card) => card.chatId !== turn.chatId);
      const state = deps.accounts.read()[runsOn]?.state;
      const card: OpenProviderCard = {
        messageId,
        chatId: turn.chatId,
        agentName: turn.agentName,
        runsOn,
        part,
        beside: written?.beside ?? [],
        since: open?.since ?? now().toISOString(),
        attempts: open?.attempts ?? 0,
        ...(state ? { stateAtFailure: state } : {}),
      };
      await writeCards([...rest, card]);
      return card;
    });

  /** A card that recovers by itself tries the stopped turn again, a few times. */
  const scheduleRecovery = (card: OpenProviderCard) => {
    if (card.part.card !== "wait" || card.part.reason === "quota") return;
    const wait = RECOVERY_DELAYS_MS[card.attempts];
    if (wait === undefined) return;
    scheduled.get(card.chatId)?.();
    scheduled.set(
      card.chatId,
      later(wait, () => {
        scheduled.delete(card.chatId);
        void serial(async () => {
          const cards = await readCards();
          const open = cards.find((candidate) => candidate.messageId === card.messageId);
          if (!open || stopped) return null;
          open.attempts += 1;
          await writeCards(cards);
          return open;
        }).then((open) => {
          if (open) resume(open.chatId, open.agentName, providerName(open.part.provider));
        });
      }),
    );
  };

  const noticePart = (outage: ProviderOutage, resolved?: ProviderFailureResolution) => {
    const card = cardKindOf(outage.reason);
    const part: ProviderOutagePart = {
      type: "provider_outage",
      outageId: outage.id,
      provider: outage.provider,
      reason: outage.reason,
      ...(outage.until ? { until: outage.until } : {}),
      chatIds: outage.chats.map((chat) => chat.chatId),
      alternatives: card === "model" ? [] : alternatives(outage.runsOn),
      card,
      ...(card === "account" && creditsOffered() ? { credits: true } : {}),
      ...(outage.part?.replacement ? { replacement: outage.part.replacement } : {}),
      ...(outage.part?.detail ? { detail: outage.part.detail } : {}),
      ...(resolved ? { resolved, resolvedAt: resolved.at } : {}),
    };
    return part;
  };

  /** Adds an unattended chat to its incident's notice, opening one with a push. */
  const groupIn = (turn: ChatTurnFailure, part: ProviderFailurePart, runsOn: AccountedProviderId) =>
    serial(async () => {
      const outages = await readOutages();
      const open = outages.find(
        (outage) => outage.provider === part.provider && outage.reason === part.reason,
      );
      if (open) {
        if (open.chats.some((chat) => chat.chatId === turn.chatId)) return;
        open.chats.push({ chatId: turn.chatId, agentName: turn.agentName });
        open.part = noticePart(open);
        await writeOutages(outages);
        await deps.webchatRepo.updateMessageContent(
          open.noticeMessageId,
          JSON.stringify([open.part]),
        );
        return;
      }
      const noticeChatId = await deps.mainChatId();
      if (!noticeChatId) return;
      const outage: ProviderOutage = {
        id: uuidv7(),
        provider: part.provider,
        runsOn,
        reason: part.reason,
        ...(part.until ? { until: part.until } : {}),
        noticeChatId,
        noticeMessageId: "",
        chats: [{ chatId: turn.chatId, agentName: turn.agentName }],
        since: now().toISOString(),
      };
      outage.part = {
        ...noticePart(outage),
        ...(part.replacement ? { replacement: part.replacement } : {}),
        ...(part.detail ? { detail: part.detail } : {}),
      };
      const message = await deps.webchatRepo.addBackendMessage(noticeChatId, uuidv7(), [
        outage.part,
      ]);
      outage.noticeMessageId = message.id;
      await writeOutages([...outages, outage]);
      await deps.notify
        ?.send({ body: outagePushText(outage), level: "active", chatId: noticeChatId })
        .catch((error: unknown) =>
          log.warn("provider outage push failed", { error: String(error) }),
        );
    });

  /** Settles the chats' cards in place, and any notice left with no chat waiting. */
  const settle = (
    match: (card: OpenProviderCard) => boolean,
    resolution: (card: OpenProviderCard) => ProviderFailureResolution,
  ) =>
    serial(async () => {
      const cards = await readCards();
      const ended = cards.filter(match);
      if (ended.length === 0) return [];
      await writeCards(cards.filter((card) => !match(card)));
      for (const card of ended) {
        scheduled.get(card.chatId)?.();
        scheduled.delete(card.chatId);
        card.part = { ...card.part, resolved: resolution(card) };
        await deps.webchatRepo
          .updateMessageContent(card.messageId, content(card))
          .catch(() => undefined);
      }
      const chatIds = new Set(ended.map((card) => card.chatId));
      const outages = await readOutages();
      const left: ProviderOutage[] = [];
      for (const outage of outages) {
        const waiting = outage.chats.filter((chat) => !chatIds.has(chat.chatId));
        if (waiting.length === outage.chats.length) {
          left.push(outage);
          continue;
        }
        if (waiting.length > 0) {
          left.push({ ...outage, chats: waiting });
          continue;
        }
        const first = ended.find((card) => outage.chats.some((c) => c.chatId === card.chatId));
        await deps.webchatRepo
          .updateMessageContent(
            outage.noticeMessageId,
            JSON.stringify([noticePart(outage, first ? resolution(first) : undefined)]),
          )
          .catch(() => undefined);
      }
      if (left.length !== outages.length || left.some((o, i) => o !== outages[i]))
        await writeOutages(left);
      return ended;
    });

  /** Moves one chat as a switch asks, before its stopped turn runs again. */
  const moveChat = async (chatId: string, agentName: string, change: ProviderSwitch) => {
    if (change.kind === "model") {
      if (!isModelSelectionId(change.selection)) throw new Error("Unknown model");
      const chat = await deps.webchatRepo.getSession(chatId);
      if (!chat) throw new Error("Chat not found");
      const by = chat.largeModelSelectionBy === "kept" || !ownerPicked(chat) ? "kept" : "owner";
      await deps.webchatRepo.updateSessionLargeModelSelection(chatId, change.selection, by);
      deps.selectModel?.(chatId, agentName, change.selection);
      return;
    }
    const provider = providerOfDefault(change.provider);
    const chat = await deps.webchatRepo.getSession(chatId);
    if (chat && ownerPicked(chat) && isModelSelectionId(chat.largeModelSelection)) {
      // A model its owner picked moves to the same strength on the new provider, still theirs.
      if (MODEL_SELECTIONS[chat.largeModelSelection].providerId === provider) return;
      const selection = selectionOfStrength(
        provider,
        strengthOfSelection(chat.largeModelSelection),
        deps.accounts.read().openai?.account,
      );
      await deps.webchatRepo.updateSessionLargeModelSelection(chatId, selection, "owner");
      deps.selectModel?.(chatId, agentName, selection);
      return;
    }
    if (change.makeDefault) await deps.chats.follow(chatId);
    else await deps.chats.keep(chatId, provider);
  };

  const switchResolution = (change: ProviderSwitch): ProviderFailureResolution =>
    change.kind === "model"
      ? {
          at: now().toISOString(),
          by: "switched",
          model: MODEL_SELECTIONS[change.selection as keyof typeof MODEL_SELECTIONS]?.model,
          continued: true,
        }
      : { at: now().toISOString(), by: "switched", provider: change.provider, continued: true };

  const switchName = (change: ProviderSwitch) =>
    change.kind === "model"
      ? (MODEL_SELECTIONS[change.selection as keyof typeof MODEL_SELECTIONS]?.model ?? "the model")
      : providerName(change.provider);

  const makeDefault = async (change: ProviderSwitch) => {
    if (change.kind === "provider" && change.makeDefault) {
      await deps.defaults.choose(change.provider, { moveExisting: true });
    }
  };

  // The provider runs again: the stopped turns run, and each card settles
  // when its turn does. One that fails again rewrites its card in place.
  const stopAccounts = deps.accounts.onChanged((provider, _change, succeeded) => {
    if (stopped || succeeded === false) return;
    if (provider !== "anthropic" && provider !== "openai") return;
    const report = deps.accounts.read()[provider];
    const state = report?.state;
    // A read that found the usage limit names when it ends: a quota card
    // without that time learns it.
    if (state === "usage_limit_reached" && report?.usageLimitUntil) {
      const until = report.usageLimitUntil;
      void serial(async () => {
        const cards = await readCards();
        const lacking = cards.filter(
          (card) => card.runsOn === provider && card.part.reason === "quota" && !card.part.until,
        );
        for (const card of lacking) {
          card.part = { ...card.part, until };
          await deps.webchatRepo
            .updateMessageContent(card.messageId, content(card))
            .catch(() => undefined);
        }
        if (lacking.length > 0) await writeCards(cards);
      });
      return;
    }
    if (state !== "available") return;
    void serial(async () => {
      const cards = await readCards();
      const due = cards.filter(
        (card) =>
          card.runsOn === provider &&
          // Only an account that read as out when the card showed, and reads
          // available now, recovered. One that read available all along
          // (billed per use, or a temporary error) would only fail again.
          card.stateAtFailure !== undefined &&
          card.stateAtFailure !== "available" &&
          (card.part.reason === "quota" ||
            card.part.reason === "login" ||
            card.part.reason === "removed"),
      );
      if (due.length === 0) return [];
      // Recorded before the turns run, so a read during them resumes nothing twice.
      for (const card of due) card.stateAtFailure = state;
      await writeCards(cards);
      return due;
    }).then((due) => {
      for (const card of due) resume(card.chatId, card.agentName, providerName(card.part.provider));
    });
  });

  // A new default moves the chats that follow it, so their cards settle and
  // their stopped turns run there. Kept chats and owner picks stay.
  const stopDefaults = deps.defaults.onChanged((change) => {
    if (stopped || !change.moveExisting) return;
    const to = providerOfDefault(change.to);
    void (async () => {
      const cards = await readCards();
      const moving: string[] = [];
      for (const card of cards) {
        if (card.runsOn === to || card.part.card === "model" || switching.has(card.chatId))
          continue;
        const chat = await deps.webchatRepo.getSession(card.chatId);
        if (chat && !ownerPicked(chat)) moving.push(card.messageId);
      }
      const ended = await settle(
        (card) => moving.includes(card.messageId),
        () => ({ at: now().toISOString(), by: "switched", provider: change.to, continued: true }),
      );
      for (const card of ended) resume(card.chatId, card.agentName, providerName(change.to));
    })().catch((error: unknown) =>
      log.warn("cards after a default change failed", { error: String(error) }),
    );
  });

  // Cards that recover by themselves try again after a restart, too.
  void readCards()
    .then((cards) => {
      for (const card of cards) {
        cardedChats.add(card.chatId);
        scheduleRecovery(card);
      }
    })
    .catch(() => undefined);

  const decide = async (
    turn: ChatTurnFailure,
    final: boolean,
  ): Promise<{
    part: ProviderFailurePart;
    runsOn: AccountedProviderId;
    unattended: boolean;
  } | null> => {
    const classified = classify(turn.failure);
    if (!classified) return null;
    const chat = await deps.webchatRepo.getSession(turn.chatId);
    if (!chat) return null;
    // A recovery turn's failure is final: it is never recovered again.
    const last = final || recovering.has(turn.chatId);
    const concierge = isConciergeChat(chat);
    const failure = classified.failure;
    if (classified.reason === "temporary" && !last) {
      // The Concierge retries its own chats, and says when that failed too.
      if (concierge) return null;
      const sessionId = turn.sessionId ?? (await deps.runtimeOf(turn.chatId, turn.agentName));
      if (!sessionId) return null;
      recovering.add(turn.chatId);
      void delay(RETRY_DELAY_MS)
        .then(() => (stopped ? undefined : run(turn.chatId, turn.agentName, "the provider")))
        .catch((error: unknown) =>
          log.warn("provider retry failed", { chatId: turn.chatId, error: String(error) }),
        )
        .finally(() => recovering.delete(turn.chatId));
      return null;
    }
    if (
      (classified.reason === "capacity" || classified.reason === "model_unavailable") &&
      !last &&
      failure
    ) {
      // The Concierge moves its own chats to another model, and says when it could not.
      if (concierge) return null;
      if (!ownerPicked(chat) && (await deps.swapModel?.(turn.chatId, turn.agentName, failure))) {
        resume(turn.chatId, turn.agentName, providerName(named(classified.provider)));
        return null;
      }
    }
    if (failure && !classified.model) {
      const selection = chat.largeModelSelection;
      if (isModelSelectionId(selection)) classified.model = MODEL_SELECTIONS[selection].model;
    }
    const part = await cardPart(turn.chatId, turn.agentName, classified);
    if (!part) return null;
    return {
      part,
      runsOn: classified.provider,
      unattended: chat.triggerKind === TASK_CHAT_TRIGGER_KIND,
    };
  };

  /** The failure with its agent named as its sessions are, so a resume finds them. */
  const canonical = (turn: ChatTurnFailure): ChatTurnFailure => ({
    ...turn,
    agentName: deps.canonicalAgent?.(turn.agentName) ?? turn.agentName,
  });

  return {
    async failed(raw, options) {
      if (stopped) return;
      const turn = canonical(raw);
      const decided = await decide(turn, options?.final === true);
      if (!decided) return;
      const card = await writeCard(turn, decided.part, decided.runsOn);
      scheduleRecovery(card);
      if (decided.unattended) await groupIn(turn, decided.part, decided.runsOn);
      // The account read that knows when the limit ends.
      if (decided.part.reason === "quota" && !decided.part.until) {
        void deps.accounts.refresh?.(decided.runsOn).catch(() => undefined);
      }
    },
    async cardFor(raw, messageId, beside) {
      if (stopped) return null;
      const turn = canonical(raw);
      const decided = await decide(turn, true);
      if (!decided) return null;
      const card = await writeCard(turn, decided.part, decided.runsOn, { messageId, beside });
      scheduleRecovery(card);
      if (decided.unattended) await groupIn(turn, decided.part, decided.runsOn);
      return decided.part;
    },
    async succeeded(chatId) {
      if (!cardedChats.has(chatId)) return;
      await settle(
        (card) => card.chatId === chatId,
        () => ({ at: now().toISOString(), by: "recovered", continued: true }),
      );
    },
    async switchCard(messageId, change) {
      const card = (await readCards()).find((candidate) => candidate.messageId === messageId);
      if (!card) throw new Error("This card is already settled");
      switching.add(card.chatId);
      try {
        await makeDefault(change);
        await moveChat(card.chatId, card.agentName, change);
        await settle(
          (candidate) => candidate.messageId === messageId,
          () => switchResolution(change),
        );
      } finally {
        switching.delete(card.chatId);
      }
      resume(card.chatId, card.agentName, switchName(change));
    },
    async switchOutage(outageId, change) {
      const outage = (await readOutages()).find((candidate) => candidate.id === outageId);
      if (!outage) throw new Error("This notice is already settled");
      for (const chat of outage.chats) switching.add(chat.chatId);
      try {
        await makeDefault(change);
      } catch (error) {
        for (const chat of outage.chats) switching.delete(chat.chatId);
        throw error;
      }
      let moved = 0;
      for (const chat of outage.chats) {
        try {
          await moveChat(chat.chatId, chat.agentName, change);
          moved += 1;
        } catch (error) {
          log.warn("outage chat switch failed", { chatId: chat.chatId, error: String(error) });
        }
      }
      const chatIds = new Set(outage.chats.map((chat) => chat.chatId));
      await settle(
        (card) => chatIds.has(card.chatId),
        () => switchResolution(change),
      );
      // A chat whose card was already gone settles with the notice all the same.
      await serial(async () => {
        const outages = await readOutages();
        const still = outages.find((candidate) => candidate.id === outageId);
        if (!still) return;
        await writeOutages(outages.filter((candidate) => candidate.id !== outageId));
        await deps.webchatRepo
          .updateMessageContent(
            still.noticeMessageId,
            JSON.stringify([noticePart(still, switchResolution(change))]),
          )
          .catch(() => undefined);
      });
      for (const chat of outage.chats) {
        switching.delete(chat.chatId);
        resume(chat.chatId, chat.agentName, switchName(change));
      }
      return moved;
    },
    async resend(chatId, agentName) {
      const sessionId = await deps.runtimeOf(chatId, agentName);
      if (!sessionId) throw new Error("This chat has no session to resend in");
      resume(chatId, agentName, "the provider");
    },
    carded: (chatId) => cardedChats.has(chatId),
    cards: readCards,
    outages: readOutages,
    stop() {
      stopped = true;
      stopAccounts();
      stopDefaults();
      for (const cancel of scheduled.values()) cancel();
      scheduled.clear();
    },
  };
}
