import { canonicalModelSelection } from "@rome/api-types/models";
// What a dashboard chat shows when the provider its turn needed cannot run.
// Rome never moves a chat to another provider on its own. It recovers by
// itself only when no context is lost, no money is spent and nobody's pick is
// overridden: a temporary error gets one silent retry, and a single model's
// limit moves a chat that follows the default to another model of the same
// provider, with a note. Anything else shows one of three cards, by what the
// guardian has to do: wait, fix the account, or change the model. A card
// settles in place, to one line, when a turn of its chat runs: the guardian's
// next message, the usage-limit continuation once a quota resets, or the
// card's own button, which runs the stopped turn at once. Unattended chats
// (task chats, scheduled runs, routines) get their card too, and their owner's
// Concierge main chat gets one notice per incident, which informs only.
// docs/domains/agents.md#provider-failure

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
  runsOnRomeCredits,
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
import type { SessionActor } from "../access/session-actor.js";
import type { SettingsRepository } from "../db/repositories/settings.js";
import { createLogger } from "../logger.js";
import type { ChatProviders } from "./chat-providers.js";
import { type ConciergeOwner, GUARDIAN_OWNER, ownerOf } from "./owner.js";
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
}

/** One incident that stopped unattended chats, as stored. */
export interface ProviderOutage {
  id: string;
  provider: DefaultModelProvider;
  reason: ProviderFailureReason;
  until?: string;
  /** The Concierge main chat and the notice in it. */
  noticeChatId: string;
  noticeMessageId: string;
  /** The chats stopped. */
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

/** What a card's switch does. */
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
  defaults: Pick<DefaultProviders, "current" | "signedIn" | "choose">;
  chats: Pick<ChatProviders, "keep" | "follow" | "pick">;
  webchatRepo: Pick<
    WebChatRepository,
    "getSession" | "addBackendMessage" | "updateMessageContent" | "updateSessionLargeModelSelection"
  >;
  settings: Pick<SettingsRepository, "get" | "set">;
  /** An owner's Concierge main chat, or null when it does not exist. */
  mainChatId: (owner: ConciergeOwner) => Promise<string | null>;
  /** The runtime session of a chat's agent, opening one when the chat has none. */
  runtimeOf: (chatId: string, agentName: string) => Promise<string | null>;
  runner: ContinuationRunner;
  /**
   * Moves a chat that follows the default to another model of the same
   * provider after a single model's limit, with its note. Null when there is
   * none to move to, or the chat's owner picked its model.
   */
  swapModel?: (chatId: string, agentName: string, failure: AgentTurnFailure) => Promise<unknown>;
  /**
   * Whether someone wrote in the chat after `since` (ms), or it was archived:
   * a turn Rome runs again then gives way. Read when the turn is dispatched.
   * Absent, nobody did.
   */
  movedOnSince?: (chatId: string, since: number) => boolean;
  /**
   * The id of the newest message the chat shows, or null when it has none.
   * Absent, a card is never rewritten in place.
   */
  newestMessageId?: (chatId: string) => Promise<string | null>;
  /**
   * Whether the usage-limit continuation, sweeping once the limit ends at
   * `until`, would run the chat's stopped turn again. Absent, it would not.
   */
  continuesAfterLimit?: (chatId: string, until: string) => boolean;
  /** Rome credits can be spent now: linked, enabled and with a balance. */
  creditsUsable?: () => boolean;
  /**
   * Whether the chat is held on a provider, so it runs on the guardian's own
   * account even while Rome credits are the default. Absent, none is.
   */
  held?: (chatId: string) => boolean;
  /** Who a recovery turn acts for: the chat's owner. Absent, no one. */
  actorOf?: (chatId: string) => Promise<SessionActor | undefined>;
  /** Tells a live session of the chat the model its next turn runs. */
  selectModel?: (chatId: string, agentName: string, selection: string | null) => void;
  /** An agent's canonical id ("core:main") for the name a chat uses ("main"). */
  canonicalAgent?: (agentName: string) => string;
  /** Pushes to the phone of the person `owner` names. Absent, nothing is pushed. */
  notify?: {
    send(content: {
      owner: ConciergeOwner;
      body: string;
      level?: "active" | "passive";
      chatId?: string;
    }): Promise<unknown>;
  };
  delay?: (ms: number) => Promise<void>;
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
  /**
   * A turn in the chat ran to its end: its open card has recovered. `answers`
   * says the turn answered a person's request; a system turn settles nothing,
   * unless it is a recovery of the stopped turn itself.
   */
  succeeded(chatId: string, answers?: boolean): Promise<void>;
  /**
   * A recovery outside the cards, the usage-limit continuation, is running
   * the chat's stopped turn: when it succeeds, the chat's card settles.
   */
  continuing(chatId: string): void;
  /** A turn of the chat was interrupted: a recovery it was ends unfinished. */
  interrupted(chatId: string): void;
  /**
   * A card's switch: this chat moves, and its stopped turn runs again at once.
   * An option that no longer works writes a fresh card with the options that
   * work now, and runs nothing: `refreshed`.
   */
  switchCard(messageId: string, change: ProviderSwitch): Promise<"refreshed" | undefined>;
  /** A card's [Continue] or [Retry]: its stopped turn runs again at once, where it ran. */
  continueCard(messageId: string): Promise<void>;
  /**
   * The message `cardFor` named is written now: a card that settled before it
   * existed takes its settled form.
   */
  written(messageId: string): Promise<void>;
  /** Whether the chat has a card not settled yet. */
  carded(chatId: string): boolean;
  cards(): Promise<OpenProviderCard[]>;
  outages(): Promise<ProviderOutage[]>;
  stop(): void;
}

/** A card's option that no longer works: the card is written again with those that do. */
class StaleOption extends Error {}

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
        return `${name} quota used up${outage.until ? `, continues after ${clock(outage.until)}` : ""}`;
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
  let stopped = false;
  // Chats whose recovery turn is running or waiting to: its failure is final,
  // and a second way out of the card runs nothing.
  const recovering = new Set<string>();
  // The recovery runs in flight, by chat.
  const runs = new Map<string, Promise<void>>();
  // Chats whose dispatched turn is a recovery of their stopped turn: its
  // success settles the card, though it answers no one.
  const resuming = new Set<string>();
  // Chats Rome just moved to another model: one more model limit shows a card.
  const swapped = new Set<string>();
  // Chats with a card not settled, kept in memory so a read can ask synchronously.
  const cardedChats = new Set<string>();
  // Each chat's open card, by its message.
  const openCardOf = new Map<string, string>();
  // The silent retry each chat waits on, until it starts. Dropping it leaves
  // the turn to whatever settled its card.
  const retries = new Map<string, { started: boolean }>();
  const dropRetry = (chatId: string) => {
    const retry = retries.get(chatId);
    if (!retry) return;
    retries.delete(chatId);
    if (!retry.started) recovering.delete(chatId);
  };
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
    openCardOf.clear();
    for (const card of cards) {
      cardedChats.add(card.chatId);
      openCardOf.set(card.chatId, card.messageId);
    }
  };
  const readOutages = () => readList<ProviderOutage>(PROVIDER_OUTAGES_SETTING_KEY);
  const writeOutages = (outages: ProviderOutage[]) =>
    deps.settings.set(PROVIDER_OUTAGES_SETTING_KEY, outages);

  /** Every chat runs on Rome credits: the instance's default, while no account is logged in. */
  const onCredits = () => runsOnRomeCredits(deps.defaults.current(), deps.defaults.signedIn());

  /**
   * The provider as the guardian names it: Codex on Rome credits reads as Rome
   * credits, except in a chat held on the guardian's own ChatGPT login.
   */
  const named = (provider: AccountedProviderId, chatId: string): DefaultModelProvider =>
    provider === "openai" && onCredits() && deps.held?.(chatId) !== true
      ? "rome_credits"
      : provider;

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

  const classify = (failure: ChatTurnFailure["failure"], chatId: string): Classified | null => {
    const classified = classifyTurn(failure);
    // Codex on Rome credits that cannot run has no credits left: the guardian's
    // ChatGPT login has nothing to do with it. A held chat runs on that login.
    if (
      classified?.provider === "openai" &&
      onCredits() &&
      deps.held?.(chatId) !== true &&
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
        // The model the resolver refused, so the card offers the provider's other one.
        return {
          provider,
          reason: "model_unavailable",
          detail: payload.error,
          ...(payload.model ? { model: payload.model } : {}),
        };
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

  /**
   * Runs the chat's stopped turn again. The caller marks the chat as
   * recovering. `decided` hears, when the queue reaches the turn, whether it
   * runs: not once Rome is stopping, nor when someone wrote in the chat since
   * it was asked, whose own turn answers instead.
   */
  const run = async (
    chatId: string,
    agentName: string,
    provider: string,
    decided?: (runs: boolean) => Promise<unknown>,
    /** The card a click runs it for: once that card settled or moved on, nothing runs. */
    forCard?: string,
  ): Promise<void> => {
    const asked = now().getTime();
    const sessionId = await deps.runtimeOf(chatId, agentName).catch(() => null);
    if (!sessionId) {
      log.warn("provider recovery has no session to run in", { chatId });
      await decided?.(false);
      return;
    }
    const actor = await deps.actorOf?.(chatId).catch(() => undefined);
    await deps.runner.runAndReport(
      {
        agentName,
        sessionId,
        channel: "webchat",
        threadId: chatId,
        prompt: retryPrompt(provider),
      },
      {
        inputLabel: "Provider recovery",
        ...(actor ? { actor } : {}),
        shouldRun: () => {
          // A restart cuts it: the card stays as it is, for a click or a message.
          // The usage-limit continuation runs the turn already: its outcome settles the card.
          if (stopped || resuming.has(chatId)) return false;
          // Another recovery ran it meanwhile, or a newer failure replaced the card.
          if (forCard && openCardOf.get(chatId) !== forCard) return false;
          const runs = !(deps.movedOnSince?.(chatId, asked) ?? false);
          if (runs) resuming.add(chatId);
          void decided?.(runs).catch(() => undefined);
          return runs;
        },
      },
    );
  };

  /**
   * Runs the stopped turn again without waiting for it, unless a recovery of
   * the chat runs already: two ways out of one card run it once.
   */
  const resume = (
    chatId: string,
    agentName: string,
    provider: string,
    decided?: (runs: boolean) => Promise<unknown>,
  ): boolean => {
    if (recovering.has(chatId)) return false;
    recovering.add(chatId);
    runClaimed(chatId, agentName, provider, decided);
    return true;
  };

  /** Runs the turn for a chat already marked as recovering, which it clears once done. */
  const runClaimed = (
    chatId: string,
    agentName: string,
    provider: string,
    decided?: (runs: boolean) => Promise<unknown>,
    forCard?: string,
  ) => {
    const running = run(chatId, agentName, provider, decided, forCard)
      .catch((error: unknown) =>
        log.warn("provider recovery turn failed", { chatId, error: String(error) }),
      )
      .finally(() => {
        recovering.delete(chatId);
        if (runs.get(chatId) === running) runs.delete(chatId);
      });
    runs.set(chatId, running);
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
    const provider = named(failed.provider, chatId);
    // Rome credits are no way out of their own failure.
    const credits =
      card === "account" &&
      failed.reason !== "credits_used_up" &&
      provider !== "rome_credits" &&
      creditsOffered();
    return {
      type: "provider_failure",
      provider,
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
   * card: an older one leaves its message, which keeps what else it held. A
   * turn refused before it started (`inPlace`) leaves nothing of its own in
   * the chat, so while the open card is still the chat's newest message it is
   * rewritten there: refusals that repeat add no message.
   */
  const writeCard = (
    turn: Pick<ChatTurnFailure, "chatId" | "agentName" | "turnId">,
    part: ProviderFailurePart,
    runsOn: AccountedProviderId,
    written?: { messageId: string; beside: unknown[] },
    inPlace = false,
  ) =>
    serial(async () => {
      const cards = await readCards();
      const open = cards.find((card) => card.chatId === turn.chatId);
      if (
        open &&
        inPlace &&
        (await deps.newestMessageId?.(turn.chatId).catch(() => null)) === open.messageId
      ) {
        const rewritten: OpenProviderCard = { ...open, agentName: turn.agentName, runsOn, part };
        const wrote = await deps.webchatRepo
          .updateMessageContent(open.messageId, content(rewritten))
          .catch(() => false);
        if (wrote) {
          await writeCards([...cards.filter((other) => other.chatId !== turn.chatId), rewritten]);
          return rewritten;
        }
      }
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
      const card: OpenProviderCard = {
        messageId,
        chatId: turn.chatId,
        agentName: turn.agentName,
        runsOn,
        part,
        beside: written?.beside ?? [],
        since: open?.since ?? now().toISOString(),
      };
      await writeCards([...cards.filter((other) => other.chatId !== turn.chatId), card]);
      return card;
    });

  /** The notice: what stopped, and the task links. It informs; each task's card acts. */
  const noticePart = (outage: ProviderOutage, resolved?: ProviderFailureResolution) => {
    const part: ProviderOutagePart = {
      type: "provider_outage",
      outageId: outage.id,
      provider: outage.provider,
      reason: outage.reason,
      ...(outage.until ? { until: outage.until } : {}),
      chatIds: outage.chats.map((chat) => chat.chatId),
      card: cardKindOf(outage.reason),
      ...(resolved ? { resolved, resolvedAt: resolved.at } : {}),
    };
    return part;
  };

  /**
   * Adds an unattended chat to its incident's notice, in its owner's main
   * chat, opening one with a push to that owner.
   */
  const groupIn = (turn: ChatTurnFailure, part: ProviderFailurePart) =>
    serial(async () => {
      const chat = await deps.webchatRepo.getSession(turn.chatId);
      const owner = chat ? ownerOf(chat) : GUARDIAN_OWNER;
      const noticeChatId = await deps.mainChatId(owner);
      if (!noticeChatId) return;
      const outages = await readOutages();
      const open = outages.find(
        (outage) =>
          outage.provider === part.provider &&
          outage.reason === part.reason &&
          outage.noticeChatId === noticeChatId,
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
      const outage: ProviderOutage = {
        id: uuidv7(),
        provider: part.provider,
        reason: part.reason,
        ...(part.until ? { until: part.until } : {}),
        noticeChatId,
        noticeMessageId: "",
        chats: [{ chatId: turn.chatId, agentName: turn.agentName }],
        since: now().toISOString(),
      };
      outage.part = noticePart(outage);
      const message = await deps.webchatRepo.addBackendMessage(noticeChatId, uuidv7(), [
        outage.part,
      ]);
      outage.noticeMessageId = message.id;
      await writeOutages([...outages, outage]);
      await deps.notify
        ?.send({ owner, body: outagePushText(outage), level: "active", chatId: noticeChatId })
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
        dropRetry(card.chatId);
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

  /**
   * Moves one chat as a switch asks, before its stopped turn runs again. Rome
   * credits are the instance's: choosing them makes them the default, and
   * every chat follows.
   */
  const moveChat = async (
    card: OpenProviderCard,
    chatId: string,
    agentName: string,
    change: ProviderSwitch,
  ) => {
    const chat = await deps.webchatRepo.getSession(chatId);
    if (!chat) throw new Error("Chat not found");
    // Options stay as the card wrote them: one that no longer works refreshes the card.
    if (change.kind === "model") {
      if (!isModelSelectionId(change.selection)) throw new Error("Unknown model");
      const now_ = card.part.model
        ? sameProviderTarget(deps.accounts.read(), card.runsOn, card.part.model)
        : null;
      if (
        canonicalModelSelection(card.part.replacement?.selection) === change.selection &&
        now_?.selectionId !== change.selection
      ) {
        throw new StaleOption();
      }
      const by = chat.largeModelSelectionBy === "kept" || !ownerPicked(chat) ? "kept" : "owner";
      await deps.webchatRepo.updateSessionLargeModelSelection(chatId, change.selection, by);
      deps.selectModel?.(chatId, agentName, change.selection);
      return;
    }
    const choose = async (provider: DefaultProvider, moveExisting: boolean) => {
      try {
        await deps.defaults.choose(provider, { moveExisting });
      } catch (error) {
        // The provider logged out since the card was written; anything else is an error.
        if (error instanceof Error && /not signed in/.test(error.message)) throw new StaleOption();
        throw error;
      }
    };
    if (change.provider === "rome_credits") {
      if (!creditsOffered()) throw new StaleOption();
      await choose("rome_credits", true);
      // Rome credits are the instance's, so every chat runs on them without a
      // checkbox: the card offers them only when no account can run. Choosing
      // them moves existing chats, which lets every held one follow them too.
      return;
    }
    if (!alternatives(card.runsOn).includes(change.provider)) throw new StaleOption();
    if (change.makeDefault) await choose(change.provider, change.moveExisting !== false);
    const provider = providerOfDefault(change.provider);
    if (ownerPicked(chat) && isModelSelectionId(chat.largeModelSelection)) {
      // A model its owner picked moves to the same strength on the new
      // provider, still theirs.
      const stored = chat.largeModelSelection;
      const account = deps.accounts.read().openai?.account;
      const selection =
        MODEL_SELECTIONS[stored].providerId === provider
          ? stored
          : selectionOfStrength(provider, strengthOfSelection(stored, account), account);
      // Still the owner's, in one transition with its hold, so its subagents follow.
      if (selection !== stored) await deps.chats.pick(chatId, selection);
      return;
    }
    if (change.makeDefault) await deps.chats.follow(chatId);
    else await deps.chats.keep(chatId, provider);
  };

  const switchResolution = (change: ProviderSwitch, continued: boolean) =>
    change.kind === "model"
      ? {
          at: now().toISOString(),
          by: "switched" as const,
          model: MODEL_SELECTIONS[change.selection as keyof typeof MODEL_SELECTIONS]?.model,
          continued,
        }
      : { at: now().toISOString(), by: "switched" as const, provider: change.provider, continued };

  /** What a resumed turn names as the provider that could not run it: the one that failed. */
  const failedName = (card: OpenProviderCard) => providerName(card.part.provider);

  /**
   * A card's button runs its stopped turn at once, in memory: the card settles
   * when the queue reaches the turn, continued only when it runs. A restart
   * before then leaves the card open.
   */
  /** Writes the card again, as a fresh one, with the options that work now. */
  const refresh = async (card: OpenProviderCard) => {
    const part = await cardPart(card.chatId, card.agentName, {
      provider: card.runsOn,
      reason: card.part.reason,
      ...(card.part.until ? { until: card.part.until } : {}),
      ...(card.part.model ? { model: card.part.model } : {}),
      ...(card.part.detail ? { detail: card.part.detail } : {}),
    });
    if (!part) return;
    await writeCard({ chatId: card.chatId, agentName: card.agentName }, part, card.runsOn);
  };

  const runFromCard = async (
    messageId: string,
    before: (card: OpenProviderCard) => Promise<void>,
    resolution: (continued: boolean) => ProviderFailureResolution,
  ): Promise<"refreshed" | undefined> => {
    const card = (await readCards()).find((candidate) => candidate.messageId === messageId);
    if (!card) throw new Error("This card is already settled");
    // Taken before anything awaits, so a second click or another tab finds it taken.
    if (recovering.has(card.chatId) || resuming.has(card.chatId)) {
      throw new Error("This chat is already continuing");
    }
    recovering.add(card.chatId);
    try {
      await before(card);
    } catch (error) {
      recovering.delete(card.chatId);
      if (!(error instanceof StaleOption)) throw error;
      await refresh(card);
      return "refreshed";
    }
    runClaimed(
      card.chatId,
      card.agentName,
      failedName(card),
      (runs) =>
        settle(
          (open) => open.messageId === messageId,
          () => resolution(runs),
        ),
      messageId,
    );
    return undefined;
  };

  /**
   * Inside `serial`: whether each quota card's turn will be continued once its
   * limit ends, as the usage-limit continuation decides, so the card promises
   * only what will happen. True when it changed.
   */
  const promise = (card: OpenProviderCard): boolean => {
    if (card.part.reason !== "quota" || !card.part.until) return false;
    const continues = deps.continuesAfterLimit?.(card.chatId, card.part.until) === true;
    if ((card.part.continues === true) === continues) return false;
    const { continues: _was, ...part } = card.part;
    card.part = continues ? { ...part, continues: true } : part;
    return true;
  };

  /** Rereads what the chats' quota cards may promise, and rewrites the ones that changed. */
  const repromise = (match: (card: OpenProviderCard) => boolean) =>
    serial(async () => {
      const cards = await readCards();
      let changed = false;
      for (const card of cards) {
        if (!match(card) || !promise(card)) continue;
        changed = true;
        await deps.webchatRepo
          .updateMessageContent(card.messageId, content(card))
          .catch(() => undefined);
      }
      if (changed) await writeCards(cards);
    });

  // A usage limit names when it ends: a quota card written without that time
  // learns it from the account read, for its copy, and what it may promise.
  const stopAccounts = deps.accounts.onChanged((provider, _change, succeeded) => {
    if (stopped || succeeded === false) return;
    if (provider !== "anthropic" && provider !== "openai") return;
    const report = deps.accounts.read()[provider];
    const until = report?.state === "usage_limit_reached" ? report.usageLimitUntil : undefined;
    if (!until) return;
    const waiting = (card: OpenProviderCard) =>
      card.runsOn === provider && card.part.reason === "quota";
    void serial(async () => {
      const cards = await readCards();
      const learning = cards.filter((card) => waiting(card) && !card.part.until);
      if (learning.length === 0) return;
      for (const card of learning) {
        card.part = { ...card.part, until };
        promise(card);
        await deps.webchatRepo
          .updateMessageContent(card.messageId, content(card))
          .catch(() => undefined);
      }
      await writeCards(cards);
    }).then(() => repromise(waiting));
  });

  // The open cards, known at once, so a read of the chat can ask synchronously.
  void readCards()
    .then((cards) => {
      for (const card of cards) {
        cardedChats.add(card.chatId);
        openCardOf.set(card.chatId, card.messageId);
      }
    })
    .catch((error: unknown) =>
      log.warn("provider cards could not be read", { error: String(error) }),
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
    const classified = classify(turn.failure, turn.chatId);
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
    const quietCard = async () => {
      const quiet = await cardPart(turn.chatId, turn.agentName, classified);
      if (quiet) await writeCard(turn, { ...quiet, retrying: true }, classified.provider);
    };
    if (classified.reason === "temporary" && !last) {
      // The Concierge retries its own chats, and writes their final card: one owner.
      if (conciergeRecovers("temporary")) return null;
      // Nothing of the turn reads as failed while its one retry waits: a
      // quiet card stands in for the error.
      await quietCard();
      const sessionId = turn.sessionId ?? (await deps.runtimeOf(turn.chatId, turn.agentName));
      if (!sessionId) return null;
      // The wait counts as recovering: a card's button meanwhile leaves the
      // retry to run. A card that settles, a turn that runs, or a newer
      // failure drops it before it starts.
      recovering.add(turn.chatId);
      const token = { started: false };
      retries.set(turn.chatId, token);
      const retry = delay(RETRY_DELAY_MS)
        .then(() => {
          if (stopped || retries.get(turn.chatId) !== token) return undefined;
          token.started = true;
          retries.delete(turn.chatId);
          return run(turn.chatId, turn.agentName, "the provider");
        })
        .catch((error: unknown) =>
          log.warn("provider retry failed", { chatId: turn.chatId, error: String(error) }),
        )
        .finally(() => {
          if (token.started) recovering.delete(turn.chatId);
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
        await quietCard();
        resumeAfter(
          turn.chatId,
          turn.agentName,
          providerName(named(classified.provider, turn.chatId)),
        );
        return null;
      }
    }
    if (!classified.model) {
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
      const retried = recovering.has(raw.chatId) && !retries.has(raw.chatId);
      resuming.delete(raw.chatId);
      // A newer turn failed while a retry waited: the retry was for an older one.
      dropRetry(raw.chatId);
      const turn = canonical(raw);
      const decided = await decide(turn, options?.final === true, retried);
      if (!decided) return;
      await writeCard(
        turn,
        decided.part,
        decided.runsOn,
        undefined,
        turn.failure.kind === "resolution",
      );
      // The stopped turn is stored now: what the continuation will do with it is known.
      await repromise((card) => card.chatId === turn.chatId);
      if (decided.unattended) await groupIn(turn, decided.part);
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
      await writeCard(turn, decided.part, decided.runsOn, { messageId, beside });
      if (decided.unattended) await groupIn(turn, decided.part);
      return decided.part;
    },
    async succeeded(chatId, answers = true) {
      // A system turn answers no one: the guardian's card and its retry still
      // wait, unless the turn ran the stopped request itself.
      if (!resuming.delete(chatId) && !answers) return;
      swapped.delete(chatId);
      // A turn ran: the retry that waited for the provider is not needed.
      dropRetry(chatId);
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
    continuing(chatId) {
      if (cardedChats.has(chatId)) resuming.add(chatId);
    },
    switchCard: (messageId, change) => {
      if (change.kind === "model") {
        const id = canonicalModelSelection(change.selection);
        if (!id) return Promise.reject(new Error("Unknown model"));
        change = { ...change, selection: id };
      }
      return runFromCard(
        messageId,
        (card) => moveChat(card, card.chatId, card.agentName, change),
        (continued) => switchResolution(change, continued),
      );
    },
    continueCard: async (messageId) => {
      await runFromCard(
        messageId,
        async () => {},
        (continued) => ({ at: now().toISOString(), by: "recovered", continued }),
      );
    },
    async written(messageId) {
      const late = lateContent.get(messageId);
      if (late !== undefined) {
        lateContent.delete(messageId);
        await deps.webchatRepo.updateMessageContent(messageId, late);
        return;
      }
      // The refused send is stored now: what the continuation will do with it is known.
      await repromise((card) => card.messageId === messageId);
    },
    interrupted(chatId) {
      resuming.delete(chatId);
    },
    carded: (chatId) => cardedChats.has(chatId),
    cards: readCards,
    outages: readOutages,
    stop() {
      stopped = true;
      stopAccounts();
    },
  };
}
