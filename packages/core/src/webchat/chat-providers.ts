// Which provider a chat runs on when it does not follow the default: the
// guardian switched only this chat from a card, or changed the default
// without moving the chats already there. Such a chat is pinned to a model
// (docs/domains/agents.md#pinned-chat), and one "Back to default" lets it
// follow again. Unmoved chats are held wherever their sessions run: a web
// chat by its stored model, and any other conversation (a fork, a channel's
// chat, the subagents under either) by its session's key, held on the old
// provider.

import {
  followingSelection,
  isModelSelectionId,
  MODEL_SELECTIONS,
  type ModelTier,
  providerOfDefault,
  selectionOfStrength,
  strengthOfSelection,
  walkToRoot,
  type AccountedProviderId,
  type DefaultProvider,
  type DefaultProviderChange,
  type ModelAccounts,
  type ModelSelectionId,
} from "../agent/index.js";
import { webchatSessionKey } from "../core/agent-session-key.js";
import type { SettingsRepository } from "../db/repositories/settings.js";
import { createLogger } from "../logger.js";
import type { WebChatRepository } from "./repository.js";

/** The conversations held on a provider, by their root session key. */
export const HELD_SESSIONS_SETTING_KEY = "heldSessions";

/** A one-off run's key, `<agent>:<uuid>`, which no later turn reuses. */
const ADHOC_KEY = /^[^:]+:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** What a chat runs on when it does not follow the default, as the chat APIs show it. */
export interface PinnedModel {
  /** `owner` when its owner picked the model, `kept` when a card or a change of the default kept it. */
  by: "owner" | "kept";
  providerId: string;
  /** Null for a conversation held with no model of its own, such as a fork: it runs the model it last ran there. */
  selection: string | null;
  model: string | null;
}

/**
 * The model a chat is pinned to, or null when it follows the default. An
 * owner's pick and a kept chat are pinned. A selection Rome made is not.
 * `held` is the provider the chat's conversation is held on, for a chat with
 * no stored model, such as a fork.
 */
export function pinnedModelOf(
  chat: { largeModelSelection?: string | null; largeModelSelectionBy?: string | null },
  held?: AccountedProviderId,
): PinnedModel | null {
  const stored = chat.largeModelSelection ?? null;
  const by = chat.largeModelSelectionBy ?? null;
  if (isModelSelectionId(stored)) {
    const selection = MODEL_SELECTIONS[stored];
    // A model stored with no record of who chose it is its owner's, from before the record.
    if (by === "owner" || by === null || by === "kept") {
      return {
        by: by === "kept" ? "kept" : "owner",
        providerId: selection.providerId,
        selection: stored,
        model: selection.model,
      };
    }
    if (!held || selection.providerId === held) return null;
  }
  if (!held) return null;
  return { by: "kept", providerId: held, selection: null, model: null };
}

const log = createLogger("chat-providers");

export interface ChatProvidersDeps {
  webchatRepo: Pick<
    WebChatRepository,
    | "getSession"
    | "followingChats"
    | "keptChatCount"
    | "releaseKeptChats"
    | "updateSessionLargeModelSelection"
  >;
  accounts: Pick<ModelAccounts, "read">;
  /** Where the held conversations are kept. Absent, only in memory. */
  settings?: Pick<SettingsRepository, "get" | "set">;
  /** The default now, so a chat that goes back to it runs its strength there. */
  currentDefault?: () => DefaultProvider | null;
  /**
   * The keys of the live sessions whose last turn ran on `provider`: every
   * conversation, a fork's, a channel's and a subagent's included.
   */
  ranOn?: (provider: AccountedProviderId) => Promise<string[]>;
  /** Tells a chat's live session, if one is open, the model its next turn runs. */
  selectModel: (
    chatId: string,
    agentName: string | null,
    selection: ModelSelectionId | null,
  ) => void;
  /** The model the chat's session last ran, when it ran one. */
  lastModel?: (
    chatId: string,
    agentName: string | null,
  ) => Promise<{ providerId: string; model: string } | null>;
  /** The tier the chat's agent asks for, when it names one. */
  agentTier?: (agentName: string | null) => ModelTier | undefined;
}

export interface ChatProviders {
  /** Loads the held conversations. `heldProvider` reads none before it. */
  ready(): Promise<void>;
  /** Before a change of the default is stored: keeps the chats there, or lets them move. */
  beforeDefaultChange(change: DefaultProviderChange): Promise<void>;
  /**
   * The provider a session is held on, by its key, read through its root, so
   * a subagent or fork stays where its conversation is. Undefined when it
   * follows the default.
   */
  heldProvider(channelThreadKey: string): AccountedProviderId | undefined;
  /**
   * Keeps one chat on `provider`, at the strength it runs now. Null for a
   * chat its owner picked a model for.
   */
  keep(chatId: string, provider: AccountedProviderId): Promise<ModelSelectionId | null>;
  /**
   * "Back to default": one pinned chat follows the default again, from its
   * next run, at the strength it runs now, whether it was kept or its owner
   * picked the model. Returns the model it runs next, or null when it already
   * followed the default.
   */
  follow(chatId: string): Promise<ModelSelectionId | null>;
  /**
   * How many chats a change of the default that moves existing chats would
   * move: those that follow it, the kept ones it lets follow it again, and
   * the other held conversations.
   */
  followingCount(): Promise<number>;
}

/** The selection that runs `model`, ignoring a context-window suffix. */
export function selectionOfModel(model: string): ModelSelectionId | null {
  const bare = model.replace(/\[[^\]]*\]$/, "");
  for (const selection of Object.values(MODEL_SELECTIONS)) {
    if (selection.model === model || selection.model.replace(/\[[^\]]*\]$/, "") === bare) {
      return selection.id as ModelSelectionId;
    }
  }
  return null;
}

export function createChatProviders(deps: ChatProvidersDeps): ChatProviders {
  /**
   * The model a chat is kept on, on `provider`: its stored model, else the one
   * its session last ran, else its agent's tier, each at the same strength.
   * The strength the chat runs never changes because it is kept.
   */
  const on = async (
    chatId: string,
    agentName: string | null,
    stored: string | null,
    provider: AccountedProviderId,
  ): Promise<ModelSelectionId> => {
    const codexAccount = deps.accounts.read().openai?.account;
    const ran = isModelSelectionId(stored)
      ? stored
      : await deps.lastModel?.(chatId, agentName).then(
          (last) => (last ? selectionOfModel(last.model) : null),
          () => null,
        );
    if (ran) {
      if (MODEL_SELECTIONS[ran].providerId === provider) return ran;
      return selectionOfStrength(provider, strengthOfSelection(ran, codexAccount), codexAccount);
    }
    const tier = deps.agentTier?.(agentName);
    return selectionOfStrength(provider, tier === "large" ? "strong" : "fast", codexAccount);
  };

  // The held conversations, by root session key.
  let held = new Map<string, AccountedProviderId>();
  const loaded = (async () => {
    const stored = await deps.settings?.get<unknown>(HELD_SESSIONS_SETTING_KEY).catch(() => null);
    if (!stored || typeof stored !== "object" || Array.isArray(stored)) return;
    for (const [key, provider] of Object.entries(stored as Record<string, unknown>)) {
      if (provider === "anthropic" || provider === "openai") held.set(key, provider);
    }
  })();
  const saveHeld = async (next: Map<string, AccountedProviderId>) => {
    await deps.settings?.set(HELD_SESSIONS_SETTING_KEY, Object.fromEntries(next));
    held = next;
  };
  const rootOf = (key: string) => walkToRoot(key).stored;

  const keepOn = async (
    chatId: string,
    agentName: string | null,
    stored: string | null,
    provider: AccountedProviderId,
  ) => {
    const selection = await on(chatId, agentName, stored, provider);
    await deps.webchatRepo.updateSessionLargeModelSelection(chatId, selection, "kept");
    deps.selectModel(chatId, agentName, selection);
    return selection;
  };

  return {
    ready: () => loaded,
    heldProvider: (key) => held.get(rootOf(key)),
    async beforeDefaultChange(change) {
      await loaded;
      if (change.moveExisting) {
        const released = await deps.webchatRepo.releaseKeptChats();
        if (held.size > 0) await saveHeld(new Map());
        if (released.length > 0) {
          log.info("kept chats follow the default again", { released: released.length });
        }
        return;
      }
      // Rome credits stop the moment an account is logged in: nothing stays on them.
      if (!change.from || change.from === "rome_credits") return;
      const provider = providerOfDefault(change.from);
      const chats = await deps.webchatRepo.followingChats();
      for (const chat of chats) {
        const row = await deps.webchatRepo.getSession(chat.id);
        await keepOn(chat.id, row?.agentName ?? null, chat.largeModelSelection, provider);
      }
      // Every other conversation that ran there stays too: a fork, a
      // channel's chat, and the subagents under them and under the chats.
      const next = new Map(held);
      for (const chat of chats) next.set(webchatSessionKey(chat.id), provider);
      const ran = (await deps.ranOn?.(provider)) ?? [];
      for (const key of ran) {
        const root = rootOf(key);
        if (ADHOC_KEY.test(root) || next.has(root)) continue;
        next.set(root, provider);
      }
      await saveHeld(next);
      log.info("chats kept on the old default", {
        provider,
        chats: chats.length,
        conversations: next.size - held.size,
      });
    },
    async keep(chatId, provider) {
      const chat = await deps.webchatRepo.getSession(chatId);
      if (!chat) return null;
      if (chat.largeModelSelectionBy === "owner") return null;
      if (chat.largeModelSelection && chat.largeModelSelectionBy === null) return null;
      await loaded;
      const selection = await keepOn(
        chatId,
        chat.agentName ?? null,
        chat.largeModelSelection,
        provider,
      );
      // Its subagents and forks stay with it.
      await saveHeld(new Map(held).set(webchatSessionKey(chatId), provider));
      return selection;
    },
    async follow(chatId) {
      await loaded;
      const chat = await deps.webchatRepo.getSession(chatId);
      if (!chat) return null;
      const key = webchatSessionKey(chatId);
      const heldOn = held.get(key);
      if (heldOn) {
        const next = new Map(held);
        next.delete(key);
        await saveHeld(next);
      }
      if (!pinnedModelOf(chat, heldOn)) return null;
      const stored = chat.largeModelSelection;
      if (!isModelSelectionId(stored)) {
        // Held with no model of its own, as a fork is: it follows by its tier again.
        deps.selectModel(chatId, chat.agentName ?? null, null);
        return null;
      }
      // Its strength stays: the default's model of the same strength.
      const next = followingSelection(
        stored,
        deps.currentDefault?.() ?? null,
        deps.accounts.read().openai?.account,
      );
      await deps.webchatRepo.updateSessionLargeModelSelection(chatId, next, "auto");
      deps.selectModel(chatId, chat.agentName ?? null, next);
      return next;
    },
    async followingCount() {
      await loaded;
      const [following, kept] = await Promise.all([
        deps.webchatRepo.followingChats(),
        deps.webchatRepo.keptChatCount(),
      ]);
      // Held conversations that are not a web chat, such as a channel's chat.
      const others = [...held.keys()].filter((key) => !key.startsWith("webchat:")).length;
      return following.length + kept + others;
    },
  };
}
