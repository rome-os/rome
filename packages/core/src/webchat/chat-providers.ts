// Which provider a dashboard chat that follows the default runs on, when it
// is not simply the default: the guardian switched only this chat, or changed
// the default without moving the chats already there. Such a chat is kept on
// its provider (docs/domains/agents.md#kept-provider). A model its owner
// picked is never touched here.

import {
  isModelSelectionId,
  MODEL_SELECTIONS,
  type ModelTier,
  providerOfDefault,
  selectionOfStrength,
  strengthOfSelection,
  type AccountedProviderId,
  type DefaultProvider,
  type DefaultProviderChange,
  type ModelAccounts,
  type ModelSelectionId,
} from "../agent/index.js";
import { createLogger } from "../logger.js";
import type { WebChatRepository } from "./repository.js";

const log = createLogger("chat-providers");

export interface ChatProvidersDeps {
  webchatRepo: Pick<
    WebChatRepository,
    "getSession" | "followingChats" | "releaseKeptChats" | "updateSessionLargeModelSelection"
  >;
  accounts: Pick<ModelAccounts, "read">;
  /**
   * Tells a chat's live session, if one is open, the model its next turn runs
   * and whether it runs on Rome credits.
   */
  selectModel: (
    chatId: string,
    agentName: string | null,
    selection: ModelSelectionId,
    credits?: boolean,
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
  /** Before a change of the default is stored: keeps the chats there, or lets them move. */
  beforeDefaultChange(change: DefaultProviderChange): Promise<void>;
  /**
   * Keeps one chat on `provider`, at the strength it runs now: Rome credits
   * run Codex, and only a chat kept on them spends them. Null for a chat its
   * owner picked a model for.
   */
  keep(chatId: string, provider: DefaultProvider): Promise<ModelSelectionId | null>;
  /** Lets one kept chat follow the default again, from its next run. */
  follow(chatId: string): Promise<void>;
  /** How many chats a change of the default would move. */
  followingCount(): Promise<number>;
}

/** The selection that runs `model`, ignoring a context-window suffix. */
function selectionOfModel(model: string): ModelSelectionId | null {
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
      return selectionOfStrength(provider, strengthOfSelection(ran), codexAccount);
    }
    const tier = deps.agentTier?.(agentName);
    return selectionOfStrength(provider, tier === "large" ? "strong" : "fast", codexAccount);
  };

  const keepOn = async (
    chatId: string,
    agentName: string | null,
    stored: string | null,
    provider: DefaultProvider,
  ) => {
    const credits = provider === "rome_credits";
    const selection = await on(chatId, agentName, stored, providerOfDefault(provider));
    await deps.webchatRepo.updateSessionLargeModelSelection(
      chatId,
      selection,
      credits ? "credits" : "kept",
    );
    deps.selectModel(chatId, agentName, selection, credits);
    return selection;
  };

  return {
    async beforeDefaultChange(change) {
      if (change.moveExisting) {
        const released = await deps.webchatRepo.releaseKeptChats();
        // A chat that ran on Rome credits stops spending them with its next turn.
        for (const chat of released) {
          if (isModelSelectionId(chat.largeModelSelection)) {
            deps.selectModel(chat.id, chat.agentName, chat.largeModelSelection, false);
          }
        }
        if (released.length > 0) {
          log.info("kept chats follow the default again", { released: released.length });
        }
        return;
      }
      if (!change.from) return;
      const provider = change.from as DefaultProvider;
      const chats = await deps.webchatRepo.followingChats();
      for (const chat of chats) {
        const row = await deps.webchatRepo.getSession(chat.id);
        await keepOn(chat.id, row?.agentName ?? null, chat.largeModelSelection, provider);
      }
      log.info("chats kept on the old default", { provider, chats: chats.length });
    },
    async keep(chatId, provider) {
      const chat = await deps.webchatRepo.getSession(chatId);
      if (!chat || chat.largeModelSelectionBy === "owner") return null;
      if (chat.largeModelSelection && chat.largeModelSelectionBy === null) return null;
      return await keepOn(chatId, chat.agentName ?? null, chat.largeModelSelection, provider);
    },
    async follow(chatId) {
      const chat = await deps.webchatRepo.getSession(chatId);
      const by = chat?.largeModelSelectionBy;
      if (!chat || (by !== "kept" && by !== "credits")) return;
      await deps.webchatRepo.updateSessionLargeModelSelection(
        chatId,
        chat.largeModelSelection,
        "auto",
      );
      if (by === "credits" && isModelSelectionId(chat.largeModelSelection)) {
        deps.selectModel(chatId, chat.agentName ?? null, chat.largeModelSelection, false);
      }
    },
    async followingCount() {
      return (await deps.webchatRepo.followingChats()).length;
    },
  };
}
