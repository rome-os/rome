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
  failoverReason,
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
/** Chats whose card settled as continued and whose stopped turn has not started yet. */
export const PROVIDER_RESUMES_SETTING_KEY = "providerResumes";

/** How long a temporary failure waits before its one silent retry. */
const RETRY_DELAY_MS = 30_000;
/** When a card that recovers by itself tries the stopped turn again, after it showed. */
const RECOVERY_DELAYS_MS = [5 * 60_000, 15 * 60_000, 30 * 60_000];
/** How long after a quota's reset time its card tries the stopped turn again. */
const QUOTA_RESET_SLACK_MS = 30_000;
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

/** A stopped turn a switch promised to run, kept until it starts. */
interface PendingResume {
  chatId: string;
  agentName: string;
  /** What the retry prompt names as now able to run it. */
  name: string;
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
  | {
      kind: "provider";
      provider: DefaultProvider;
      makeDefault?: boolean;
      /** With `makeDefault`: other chats move too, as Settings' "Move existing chats too". */
      moveExisting?: boolean;
    }
  | { kind: "model"; selection: string };

export interface ProviderFailuresDeps {
  /** `refresh`, when given, reads a provider's account again, as for a reset time a card lacks. */
  accounts: Pick<ModelAccounts, "read" | "onChanged"> & Partial<Pick<ModelAccounts, "refresh">>;
  defaults: Pick<DefaultProviders, "current" | "signedIn" | "choose" | "onChanged">;
  chats: Pick<ChatProviders, "keep" | "follow">;
  webchatRepo: Pick<
    WebChatRepository,
    | "getSession"
    | "addBackendMessage"
    | "updateMessageContent"
    | "updateSessionLargeModelSelection"
    | "updateSessionRomeCredits"
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
  /** Codex is logged in on Rome credits now, rather than on a ChatGPT account. */
  codexOnCredits?: () => boolean;
  /** Tells a live session of the chat the model its next turn runs, and whether on Rome credits. */
  selectModel?: (
    chatId: string,
    agentName: string,
    selection: string | null,
    credits?: boolean,
  ) => void;
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
  /**
   * The message `cardFor` named is written now: a card that settled before it
   * existed takes its settled form.
   */
  written(messageId: string): Promise<void>;
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
  // Chats whose recovery turn is running or waiting to: its failure is final.
  const recovering = new Set<string>();
  // The recovery runs in flight, by chat.
  const runs = new Map<string, Promise<void>>();
  // Chats Rome just moved to another model: one more model limit shows a card.
  const swapped = new Set<string>();
  // Chats with a card not settled, kept in memory so the usage-limit
  // continuation can ask synchronously.
  const cardedChats = new Set<string>();
  const scheduled = new Map<string, () => void>();
  // Chats a switch is moving: a default change it makes leaves them to it.
  const switching = new Set<string>();
  // Cards and notices a switch took: a second switch or a recovery leaves them.
  const claimed = new Set<string>();
  // Cards that settled before `cardFor`'s caller wrote their message: what to write.
  const lateContent = new Map<string, string>();
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

  type ChatRow = NonNullable<Awaited<ReturnType<WebChatRepository["getSession"]>>>;

  /**
   * The chat runs on Rome credits: moved onto them, or following a default of
   * them, while Codex is logged in on them rather than on a ChatGPT account.
   */
  const spendsCredits = (chat: ChatRow | null | undefined): boolean =>
    (chat?.romeCredits === true || deps.defaults.current() === "rome_credits") &&
    deps.codexOnCredits?.() !== false;

  /** The provider as the guardian names it: Codex for a chat on Rome credits reads as Rome credits. */
  const named = (provider: AccountedProviderId, chat?: ChatRow | null): DefaultModelProvider =>
    provider === "openai" && spendsCredits(chat) ? "rome_credits" : provider;

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

  const classify = (failure: ChatTurnFailure["failure"], chat: ChatRow): Classified | null => {
    const classified = classifyTurn(failure);
    // Codex on Rome credits that cannot run has no credits left: the guardian's
    // ChatGPT login has nothing to do with it.
    if (
      classified?.provider === "openai" &&
      spendsCredits(chat) &&
      (classified.reason === "login" || classified.reason === "removed")
    ) {
      return { ...classified, reason: "credits_used_up" };
    }
    return classified;
  };

  const classifyTurn = (failure: ChatTurnFailure["failure"]): Classified | null => {
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

  const readResumes = () => readList<PendingResume>(PROVIDER_RESUMES_SETTING_KEY);
  /** Inside `serial`: records turns about to run again, so a restart still runs them. */
  const addResumes = async (resumes: PendingResume[]) => {
    if (resumes.length === 0) return;
    const chatIds = new Set(resumes.map((resume) => resume.chatId));
    const kept = (await readResumes()).filter((resume) => !chatIds.has(resume.chatId));
    await deps.settings.set(PROVIDER_RESUMES_SETTING_KEY, [...kept, ...resumes]);
  };
  const dropResume = (chatId: string) =>
    serial(async () => {
      const resumes = await readResumes();
      if (!resumes.some((resume) => resume.chatId === chatId)) return;
      await deps.settings.set(
        PROVIDER_RESUMES_SETTING_KEY,
        resumes.filter((resume) => resume.chatId !== chatId),
      );
    });

  /**
   * Runs the chat's stopped turn again. The caller marks the chat as
   * recovering. A switch's resume marker clears only as the turn starts, so a
   * turn that never started still runs after a restart.
   */
  const run = async (chatId: string, agentName: string, provider: string): Promise<void> => {
    const sessionId = await deps.runtimeOf(chatId, agentName);
    if (!sessionId) throw new Error("This chat has no session to run in");
    await dropResume(chatId).catch(() => undefined);
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
  };

  /**
   * Runs the stopped turn again without waiting for it, unless a recovery of
   * the chat runs already: two ways out of one card run it once.
   */
  const resume = (chatId: string, agentName: string, provider: string): boolean => {
    if (recovering.has(chatId)) return false;
    recovering.add(chatId);
    const running = run(chatId, agentName, provider)
      .catch((error: unknown) =>
        log.warn("provider recovery turn failed", { chatId, error: String(error) }),
      )
      .finally(() => {
        recovering.delete(chatId);
        if (runs.get(chatId) === running) runs.delete(chatId);
      });
    runs.set(chatId, running);
    return true;
  };

  /** Resumes once the chat's running recovery, whose failure led here, has ended. */
  const resumeAfter = (chatId: string, agentName: string, provider: string) => {
    void (runs.get(chatId) ?? Promise.resolve()).then(() => resume(chatId, agentName, provider));
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
    // Rome credits are no way out of their own failure.
    const credits =
      card === "account" &&
      failed.reason !== "credits_used_up" &&
      named(failed.provider, chat) !== "rome_credits" &&
      creditsOffered();
    return {
      type: "provider_failure",
      provider: named(failed.provider, chat),
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
        // The older turn keeps its card, hidden, so it still reads as explained.
        const moved = {
          ...open,
          part: { ...open.part, resolved: { at: now().toISOString(), by: "moved" as const } },
        };
        await deps.webchatRepo
          .updateMessageContent(open.messageId, content(moved))
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
        attempts: open?.part.retrying ? 0 : (open?.attempts ?? 0),
        ...(state ? { stateAtFailure: state } : {}),
      };
      await writeCards([...rest, card]);
      return card;
    });

  /**
   * A card that recovers by itself tries the stopped turn again: a quota card
   * once its limit resets, any other a few times. A card a switch took is left
   * to it.
   */
  const scheduleRecovery = (card: OpenProviderCard) => {
    if (card.part.card !== "wait" || card.part.retrying) return;
    const wait =
      card.part.reason === "quota"
        ? card.part.until && card.attempts < RECOVERY_DELAYS_MS.length
          ? Math.max(0, Date.parse(card.part.until) - now().getTime()) + QUOTA_RESET_SLACK_MS
          : undefined
        : RECOVERY_DELAYS_MS[card.attempts];
    if (wait === undefined || Number.isNaN(wait)) return;
    scheduled.get(card.chatId)?.();
    scheduled.set(
      card.chatId,
      later(wait, () => {
        scheduled.delete(card.chatId);
        void serial(async () => {
          const cards = await readCards();
          const open = cards.find((candidate) => candidate.messageId === card.messageId);
          if (!open || stopped || claimed.has(open.messageId)) return null;
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
    /** Settling as continued: what the resumed turn names. Recorded before the cards settle. */
    resumeAs?: string,
  ) =>
    serial(async () => {
      const cards = await readCards();
      const ended = cards.filter(match);
      if (ended.length === 0) return [];
      if (resumeAs !== undefined) {
        await addResumes(
          ended.map((card) => ({ chatId: card.chatId, agentName: card.agentName, name: resumeAs })),
        );
      }
      await writeCards(cards.filter((card) => !match(card)));
      for (const card of ended) {
        scheduled.get(card.chatId)?.();
        scheduled.delete(card.chatId);
        card.part = { ...card.part, resolved: resolution(card) };
        const settled = content(card);
        const wrote = await deps.webchatRepo
          .updateMessageContent(card.messageId, settled)
          .catch(() => false);
        // `cardFor`'s caller has not written the message yet: it takes this form when it does.
        if (!wrote) lateContent.set(card.messageId, settled);
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
    const chat = await deps.webchatRepo.getSession(chatId);
    if (!chat) throw new Error("Chat not found");
    if (change.kind === "model") {
      if (!isModelSelectionId(change.selection)) throw new Error("Unknown model");
      const by = chat.largeModelSelectionBy === "kept" || !ownerPicked(chat) ? "kept" : "owner";
      await deps.webchatRepo.updateSessionLargeModelSelection(chatId, change.selection, by);
      // Another model is no change of provider: a chat on Rome credits stays on them.
      deps.selectModel?.(chatId, agentName, change.selection, chat.romeCredits === true);
      return;
    }
    // This chat alone moves onto Rome credits: only it spends them, and its
    // model and who chose it stay as they are.
    if (change.provider === "rome_credits" && !change.makeDefault) {
      await deps.chats.keep(chatId, "rome_credits");
      return;
    }
    const provider = providerOfDefault(change.provider);
    if (ownerPicked(chat) && isModelSelectionId(chat.largeModelSelection)) {
      if (chat.romeCredits) await deps.webchatRepo.updateSessionRomeCredits(chatId, false);
      // A model its owner picked moves to the same strength on the new
      // provider, still theirs.
      const stored = chat.largeModelSelection;
      const selection =
        MODEL_SELECTIONS[stored].providerId === provider
          ? stored
          : selectionOfStrength(
              provider,
              strengthOfSelection(stored),
              deps.accounts.read().openai?.account,
            );
      if (selection !== stored) {
        await deps.webchatRepo.updateSessionLargeModelSelection(chatId, selection, "owner");
      }
      if (selection !== stored || chat.romeCredits) {
        deps.selectModel?.(chatId, agentName, selection, false);
      }
      return;
    }
    if (change.makeDefault) await deps.chats.follow(chatId);
    else await deps.chats.keep(chatId, change.provider);
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

  /** Also making the provider the default does what Settings does, the same choice included. */
  const makeDefault = async (change: ProviderSwitch) => {
    if (change.kind === "provider" && change.makeDefault) {
      await deps.defaults.choose(change.provider, {
        moveExisting: change.moveExisting !== false,
      });
    }
  };

  // The provider runs again: the stopped turns run, and each card settles
  // when its turn does. One that fails again rewrites its card in place.
  const stopAccounts = deps.accounts.onChanged((provider, _change, succeeded) => {
    if (stopped || succeeded === false) return;
    if (provider !== "anthropic" && provider !== "openai") return;
    const report = deps.accounts.read()[provider];
    const state = report?.state;
    // A read that finds the account out is what the card waits on: a card
    // written while the account still read available records it, so the
    // read that finds it back resumes the turn. A usage limit also names
    // when it ends, which a quota card without that time learns.
    if (state === "usage_limit_reached" || state === "expired" || state === "unauthorized") {
      const until = state === "usage_limit_reached" ? report?.usageLimitUntil : undefined;
      const waits = (card: OpenProviderCard) =>
        state === "usage_limit_reached"
          ? card.part.reason === "quota"
          : card.part.reason === "login" || card.part.reason === "removed";
      void serial(async () => {
        const cards = await readCards();
        let changed = false;
        const learned: OpenProviderCard[] = [];
        for (const card of cards) {
          if (card.runsOn !== provider || !waits(card)) continue;
          if (card.stateAtFailure !== state) {
            card.stateAtFailure = state;
            changed = true;
          }
          if (until && !card.part.until) {
            card.part = { ...card.part, until };
            changed = true;
            learned.push(card);
            await deps.webchatRepo
              .updateMessageContent(card.messageId, content(card))
              .catch(() => undefined);
          }
        }
        if (changed) await writeCards(cards);
        // The reset time a card learns is when it tries again.
        for (const card of learned) scheduleRecovery(card);
      });
      return;
    }
    if (state !== "available") return;
    void serial(async () => {
      const cards = await readCards();
      const due = cards.filter(
        (card) =>
          card.runsOn === provider &&
          !claimed.has(card.messageId) &&
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
        // A quiet card waits on its own retry, which runs where the chat now runs.
        if (
          card.runsOn === to ||
          card.part.card === "model" ||
          card.part.retrying ||
          switching.has(card.chatId) ||
          claimed.has(card.messageId)
        )
          continue;
        const chat = await deps.webchatRepo.getSession(card.chatId);
        if (chat && !ownerPicked(chat)) moving.push(card.messageId);
      }
      const ended = await settle(
        (card) => moving.includes(card.messageId),
        () => ({ at: now().toISOString(), by: "switched", provider: change.to, continued: true }),
        providerName(change.to),
      );
      for (const card of ended) resume(card.chatId, card.agentName, providerName(change.to));
    })().catch((error: unknown) =>
      log.warn("cards after a default change failed", { error: String(error) }),
    );
  });

  // After a restart: the turns a switch settled run, cards that recover by
  // themselves try again, and a quiet card's lost retry runs.
  void (async () => {
    const resumes = await serial(async () => {
      const pending = await readResumes();
      if (pending.length > 0) await deps.settings.set(PROVIDER_RESUMES_SETTING_KEY, []);
      return pending;
    });
    for (const pending of resumes) resume(pending.chatId, pending.agentName, pending.name);
    const cards = await readCards();
    for (const card of cards) {
      cardedChats.add(card.chatId);
      if (card.part.retrying) {
        const cancel = later(RETRY_DELAY_MS, () => {
          scheduled.delete(card.chatId);
          if (!stopped && !claimed.has(card.messageId)) {
            resume(card.chatId, card.agentName, "the provider");
          }
        });
        scheduled.set(card.chatId, cancel);
        continue;
      }
      scheduleRecovery(card);
    }
  })().catch((error: unknown) =>
    log.warn("provider cards after a restart failed", { error: String(error) }),
  );

  const decide = async (
    turn: ChatTurnFailure,
    final: boolean,
    /** The turn was Rome's own retry, read before anything awaited. */
    retried = false,
  ): Promise<{
    part: ProviderFailurePart;
    runsOn: AccountedProviderId;
    unattended: boolean;
  } | null> => {
    const chat = await deps.webchatRepo.getSession(turn.chatId);
    if (!chat) return null;
    const classified = classify(turn.failure, chat);
    if (!classified) return null;
    // A retry's failure is final: a temporary error is retried once.
    const last = final || retried;
    const failure = classified.failure;
    // The Concierge retries and moves its own chats, but only on a
    // subscription it can fail over from: on Rome credits or an API key Rome
    // retries here.
    const conciergeRecovers = (kind: "temporary" | "model_limit") =>
      isConciergeChat(chat) &&
      failure !== undefined &&
      failoverReason(failure, deps.accounts.read()) === kind;
    if (classified.reason === "temporary" && !last) {
      // Nothing of the turn reads as failed while its one retry waits: a
      // quiet card stands in for the error.
      const quiet = await cardPart(turn.chatId, turn.agentName, classified);
      if (quiet) {
        await writeCard(turn, { ...quiet, retrying: true }, classified.provider);
      }
      if (conciergeRecovers("temporary")) return null;
      const sessionId = turn.sessionId ?? (await deps.runtimeOf(turn.chatId, turn.agentName));
      if (!sessionId) return null;
      // The wait counts as recovering: a switch or a recovery meanwhile leaves the retry to run.
      recovering.add(turn.chatId);
      const retry = delay(RETRY_DELAY_MS)
        .then(() => (stopped ? undefined : run(turn.chatId, turn.agentName, "the provider")))
        .catch((error: unknown) =>
          log.warn("provider retry failed", { chatId: turn.chatId, error: String(error) }),
        )
        .finally(() => {
          recovering.delete(turn.chatId);
          if (runs.get(turn.chatId) === retry) runs.delete(turn.chatId);
        });
      runs.set(turn.chatId, retry);
      return null;
    }
    // A single model's limit moves a chat that follows the default to another
    // model of the provider, a resumed turn included, once in a row.
    if (
      (classified.reason === "capacity" || classified.reason === "model_unavailable") &&
      !final &&
      !swapped.has(turn.chatId) &&
      failure
    ) {
      // The Concierge moves its own chats to another model, and says when it could not.
      if (conciergeRecovers("model_limit")) return null;
      if (!ownerPicked(chat) && (await deps.swapModel?.(turn.chatId, turn.agentName, failure))) {
        swapped.add(turn.chatId);
        // The move's own note says what happened: the failed turn stays quiet.
        const quiet = await cardPart(turn.chatId, turn.agentName, classified);
        if (quiet) await writeCard(turn, { ...quiet, retrying: true }, classified.provider);
        resumeAfter(turn.chatId, turn.agentName, providerName(named(classified.provider, chat)));
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
      // Read now: the retry's own run clears it as soon as its turn has ended.
      const retried = recovering.has(raw.chatId);
      const turn = canonical(raw);
      const decided = await decide(turn, options?.final === true, retried);
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
      swapped.delete(chatId);
      if (!cardedChats.has(chatId)) return;
      await settle(
        (card) => card.chatId === chatId,
        (card) =>
          // A silent retry that got past the failure stays silent.
          card.part.retrying
            ? { at: now().toISOString(), by: "moved" }
            : { at: now().toISOString(), by: "recovered", continued: true },
      );
    },
    async switchCard(messageId, change) {
      // Taken in turn with every other write, so a second click, another tab
      // or a recovery at the same moment finds it gone.
      const card = await serial(async () => {
        const open = (await readCards()).find((candidate) => candidate.messageId === messageId);
        if (!open || claimed.has(messageId)) return null;
        claimed.add(messageId);
        return open;
      });
      if (!card) throw new Error("This card is already settled");
      switching.add(card.chatId);
      let ended: OpenProviderCard[];
      try {
        await makeDefault(change);
        await moveChat(card.chatId, card.agentName, change);
        ended = await settle(
          (candidate) => candidate.messageId === messageId,
          () => switchResolution(change),
          switchName(change),
        );
      } finally {
        switching.delete(card.chatId);
        claimed.delete(messageId);
      }
      // Only the switch that settled the card runs its turn.
      if (ended.length > 0 && !resume(card.chatId, card.agentName, switchName(change))) {
        await dropResume(card.chatId);
      }
    },
    async written(messageId) {
      const late = lateContent.get(messageId);
      if (late === undefined) return;
      lateContent.delete(messageId);
      await deps.webchatRepo.updateMessageContent(messageId, late);
    },
    async switchOutage(outageId, change) {
      // The notice and its chats' cards are taken together: a card's own
      // switch at the same moment finds its card taken, and a chat whose card
      // its own switch took already is left to that switch.
      const taken = await serial(async () => {
        const open = (await readOutages()).find((candidate) => candidate.id === outageId);
        if (!open || claimed.has(outageId)) return null;
        claimed.add(outageId);
        const cards = await readCards();
        const own = new Set<string>();
        const busy = new Set<string>();
        for (const chat of open.chats) {
          const card = cards.find((candidate) => candidate.chatId === chat.chatId);
          if (!card) continue;
          if (claimed.has(card.messageId)) {
            busy.add(chat.chatId);
            continue;
          }
          claimed.add(card.messageId);
          own.add(card.messageId);
        }
        return { open, own, busy };
      });
      if (!taken) throw new Error("This notice is already settled");
      const { own: ownCards } = taken;
      const outage = {
        ...taken.open,
        chats: taken.open.chats.filter((chat) => !taken.busy.has(chat.chatId)),
      };
      for (const chat of outage.chats) switching.add(chat.chatId);
      try {
        await makeDefault(change);
        let moved = 0;
        for (const chat of outage.chats) {
          try {
            await moveChat(chat.chatId, chat.agentName, change);
            moved += 1;
          } catch (error) {
            log.warn("outage chat switch failed", { chatId: chat.chatId, error: String(error) });
          }
        }
        const ended = await settle(
          (card) => ownCards.has(card.messageId),
          () => switchResolution(change),
          switchName(change),
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
        for (const chat of outage.chats) switching.delete(chat.chatId);
        // Only the chats whose card this switch settled run again: one that
        // recovered meanwhile already ran.
        for (const card of ended) {
          if (!resume(card.chatId, card.agentName, switchName(change))) {
            await dropResume(card.chatId);
          }
        }
        return moved;
      } finally {
        for (const chat of outage.chats) switching.delete(chat.chatId);
        for (const messageId of ownCards) claimed.delete(messageId);
        claimed.delete(outageId);
      }
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
