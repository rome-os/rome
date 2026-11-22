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

/**
 * A one-off run's key, `<agent>:<uuid v4>` as `adhocSessionKey` writes it,
 * which no later turn reuses. A web chat's key is never one: its id is a
 * uuid v7.
 */
const ADHOC_KEY =
  /^(?!webchat:)[^:]+:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * How recent a conversation's last turn must be for a change of the default
 * to hold it: older ones are not reopened often enough to be worth keeping.
 */
export const HELD_SESSION_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

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
    // A model Rome chose, while the conversation is held: it stays there.
    if (!held) return null;
    return selection.providerId === held
      ? { by: "kept", providerId: held, selection: stored, model: selection.model }
      : { by: "kept", providerId: held, selection: null, model: null };
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
    | "keptChats"
    | "releaseKeptChats"
    | "updateSessionLargeModelSelection"
  >;
  accounts: Pick<ModelAccounts, "read">;
  /** Where the held conversations are kept. Absent, only in memory. */
  settings?: Pick<SettingsRepository, "get" | "set">;
  /** The default now, so a chat that goes back to it runs its strength there. */
  currentDefault?: () => DefaultProvider | null;
  /**
   * The keys of the live sessions that ran a turn and were active since
   * `since`: every conversation, a fork's, a channel's and a subagent's
   * included, whatever provider its last turn ran on.
   */
  ranSince?: (since: Date) => Promise<string[]>;
  now?: () => Date;
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
   * Lets the chat's conversation go where its own model or the default puts
   * it, leaving its stored model as it is: an owner's pick stays theirs.
   * For a chat that is deleted, or whose owner chose Auto or Rome credits.
   */
  release(chatId: string): Promise<void>;
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
  // Every change to the held map, one at a time, each from the map as the
  // one before it left it, so two at once never drop each other's change.
  let queue: Promise<unknown> = loaded;
  const changeHeld = <T>(
    change: (current: Map<string, AccountedProviderId>) => Promise<T> | T,
  ): Promise<T> => {
    const run = async () => {
      const next = new Map(held);
      const result = await change(next);
      if (next.size !== held.size || [...next].some(([key, value]) => held.get(key) !== value)) {
        await deps.settings?.set(HELD_SESSIONS_SETTING_KEY, Object.fromEntries(next));
        held = next;
      }
      return result;
    };
    const next = queue.then(run, run);
    queue = next.catch(() => undefined);
    return next;
  };
  const rootOf = (key: string) => walkToRoot(key).stored;
  const since = () => new Date((deps.now?.() ?? new Date()).getTime() - HELD_SESSION_WINDOW_MS);
  /** The conversations, by root, whose sessions were active since `from`. */
  const conversationsSince = async (from = since()) => {
    const roots = new Set<string>();
    for (const key of (await deps.ranSince?.(from)) ?? []) {
      const root = rootOf(key);
      if (!ADHOC_KEY.test(root)) roots.add(root);
    }
    return roots;
  };

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
        await changeHeld((map) => map.clear());
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
      // Every other conversation active lately stays on the old default too:
      // a fork, a channel's chat, and the subagents under them and under the
      // chats. It follows the default, so the old default is where it runs,
      // whatever provider its last turn ran on.
      const ran = await conversationsSince();
      // Every conversation with a session left, however old.
      const live = await conversationsSince(new Date(0));
      const following = new Set(chats.map((chat) => webchatSessionKey(chat.id)));
      // Where each other conversation is held: a web chat with a model of its
      // own (its owner's pick, or kept from before) is held where that model
      // runs, so its subagents stay with it. A fork whose model Rome chose is
      // kept on the old default, as a chat that follows it is.
      const holdOn = new Map<string, AccountedProviderId>();
      for (const root of ran) {
        if (following.has(root) || held.has(root)) continue;
        holdOn.set(root, provider);
        if (!root.startsWith("webchat:")) continue;
        const chatId = root.slice("webchat:".length);
        const chat = await deps.webchatRepo.getSession(chatId);
        const stored = chat?.largeModelSelection ?? null;
        if (!chat || !isModelSelectionId(stored)) continue;
        if (chat.largeModelSelectionBy === "auto") {
          await keepOn(chatId, chat.agentName ?? null, stored, provider);
          continue;
        }
        const own = MODEL_SELECTIONS[stored].providerId;
        if (own === "anthropic" || own === "openai") holdOn.set(root, own);
      }
      const added = await changeHeld((map) => {
        // A held conversation other than a web chat goes once it has no session left.
        for (const key of [...map.keys()]) {
          if (!key.startsWith("webchat:") && !live.has(key)) map.delete(key);
        }
        const before = map.size;
        for (const key of following) map.set(key, provider);
        for (const [root, on] of holdOn) if (!map.has(root)) map.set(root, on);
        return map.size - before;
      });
      log.info("chats kept on the old default", { provider, chats: chats.length, added });
    },
    async keep(chatId, provider) {
      const chat = await deps.webchatRepo.getSession(chatId);
      if (!chat) return null;
      if (chat.largeModelSelectionBy === "owner") return null;
      if (chat.largeModelSelection && chat.largeModelSelectionBy === null) return null;
      const selection = await keepOn(
        chatId,
        chat.agentName ?? null,
        chat.largeModelSelection,
        provider,
      );
      // Its subagents and forks stay with it.
      await changeHeld((map) => map.set(webchatSessionKey(chatId), provider));
      return selection;
    },
    async follow(chatId) {
      const chat = await deps.webchatRepo.getSession(chatId);
      if (!chat) return null;
      const key = webchatSessionKey(chatId);
      const heldOn = await changeHeld((map) => {
        const was = map.get(key);
        map.delete(key);
        return was;
      });
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
    async release(chatId) {
      await changeHeld((map) => map.delete(webchatSessionKey(chatId)));
    },
    async followingCount() {
      await loaded;
      const [following, kept] = await Promise.all([
        deps.webchatRepo.followingChats(),
        deps.webchatRepo.keptChats(),
      ]);
      const counted = new Set(
        [...following.map((chat) => chat.id), ...kept].map((id) => webchatSessionKey(id)),
      );
      // The other conversations a checked change would move: those held, and
      // those active lately, which follow the default. A fork chat counts; a
      // chat its owner picked a model for never moves with the default.
      let others = 0;
      for (const key of new Set([...held.keys(), ...(await conversationsSince())])) {
        if (counted.has(key)) continue;
        if (key.startsWith("webchat:")) {
          const chat = await deps.webchatRepo.getSession(key.slice("webchat:".length));
          if (!chat || pinnedModelOf(chat)?.by === "owner") continue;
        }
        others++;
      }
      return counted.size + others;
    },
  };
}
