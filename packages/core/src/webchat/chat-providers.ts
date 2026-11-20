// Which provider a dashboard chat that follows the default runs on, when it
// is not simply the default: the guardian switched only this chat, or changed
// the default without moving the chats already there. Such a chat is kept on
// its provider (docs/domains/agents.md#kept-provider). A model its owner
// picked is never touched here.

import {
  isModelSelectionId,
  MODEL_SELECTIONS,
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
  /** Tells a chat's live session, if one is open, the model its next turn runs. */
  selectModel: (chatId: string, agentName: string | null, selection: ModelSelectionId) => void;
}

export interface ChatProviders {
  /** Before a change of the default is stored: keeps the chats there, or lets them move. */
  beforeDefaultChange(change: DefaultProviderChange): Promise<void>;
  /** Keeps one chat on `provider`, at the strength it runs now. Null for a chat its owner picked a model for. */
  keep(chatId: string, provider: AccountedProviderId): Promise<ModelSelectionId | null>;
  /** Lets one kept chat follow the default again, from its next run. */
  follow(chatId: string): Promise<void>;
  /** How many chats a change of the default would move. */
  followingCount(): Promise<number>;
}

export function createChatProviders(deps: ChatProvidersDeps): ChatProviders {
  /** The model `stored` becomes on `provider`, at the same strength: the strong one when none is stored. */
  const on = (stored: string | null, provider: AccountedProviderId): ModelSelectionId => {
    const codexAccount = deps.accounts.read().openai?.account;
    if (isModelSelectionId(stored)) {
      if (MODEL_SELECTIONS[stored].providerId === provider) return stored;
      return selectionOfStrength(provider, strengthOfSelection(stored), codexAccount);
    }
    return selectionOfStrength(provider, "strong", codexAccount);
  };

  const keepOn = async (
    chatId: string,
    agentName: string | null,
    stored: string | null,
    provider: AccountedProviderId,
  ) => {
    const selection = on(stored, provider);
    await deps.webchatRepo.updateSessionLargeModelSelection(chatId, selection, "kept");
    deps.selectModel(chatId, agentName, selection);
    return selection;
  };

  return {
    async beforeDefaultChange(change) {
      if (change.moveExisting) {
        const released = await deps.webchatRepo.releaseKeptChats();
        if (released > 0) log.info("kept chats follow the default again", { released });
        return;
      }
      if (!change.from) return;
      const provider = providerOfDefault(change.from as DefaultProvider);
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
      if (chat?.largeModelSelectionBy !== "kept") return;
      await deps.webchatRepo.updateSessionLargeModelSelection(
        chatId,
        chat.largeModelSelection,
        "auto",
      );
    },
    async followingCount() {
      return (await deps.webchatRepo.followingChats()).length;
    },
  };
}
