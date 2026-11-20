// Which provider a dashboard chat that follows the default runs on, when it
// is not simply the default: the guardian switched only this chat, or changed
// the default without moving the chats already there. Such a chat is kept on
// its provider (docs/domains/agents.md#kept-provider). A model its owner
// picked is never touched here. Rome credits are a flag beside the model: a
// chat on them runs its model's strength on Codex through them.

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
  type SignedInProviders,
} from "../agent/index.js";
import { createLogger } from "../logger.js";
import type { WebChatRepository } from "./repository.js";

const log = createLogger("chat-providers");

export interface ChatProvidersDeps {
  webchatRepo: Pick<
    WebChatRepository,
    | "getSession"
    | "followingChats"
    | "keptChatCount"
    | "releaseKeptChats"
    | "updateSessionLargeModelSelection"
    | "updateSessionRomeCredits"
    | "releaseRomeCreditChats"
  >;
  accounts: Pick<ModelAccounts, "read"> & Partial<Pick<ModelAccounts, "onChanged">>;
  /**
   * The accounts logged in now. Given, any login takes every chat off Rome
   * credits: they run only while no AI account is logged in.
   */
  signedIn?: () => SignedInProviders;
  /**
   * Tells a chat's live session, if one is open, the model its next turn runs
   * and whether it runs on Rome credits.
   */
  selectModel: (
    chatId: string,
    agentName: string | null,
    selection: ModelSelectionId | null,
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
   * Keeps one chat on `provider`, at the strength it runs now. Null for a
   * chat its owner picked a model for. Rome credits instead mark the chat as
   * running on them, whoever chose its model, which stays as it is.
   */
  keep(chatId: string, provider: DefaultProvider): Promise<ModelSelectionId | null>;
  /** Takes every chat off Rome credits, back to the model it had. */
  releaseCredits(): Promise<number>;
  /** Lets one kept chat follow the default again, from its next run. */
  follow(chatId: string): Promise<void>;
  /**
   * How many chats a change of the default that moves existing chats would
   * move: those that follow it, and the kept ones it lets follow it again.
   */
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
    provider: AccountedProviderId,
    onCredits: boolean,
  ) => {
    const selection = await on(chatId, agentName, stored, provider);
    await deps.webchatRepo.updateSessionLargeModelSelection(chatId, selection, "kept");
    if (onCredits) await deps.webchatRepo.updateSessionRomeCredits(chatId, false);
    deps.selectModel(chatId, agentName, selection, false);
    return selection;
  };

  const releaseCredits = async () => {
    const released = await deps.webchatRepo.releaseRomeCreditChats();
    for (const chat of released) {
      deps.selectModel(
        chat.id,
        chat.agentName,
        isModelSelectionId(chat.largeModelSelection) ? chat.largeModelSelection : null,
        false,
      );
    }
    if (released.length > 0) {
      log.info("chats off Rome credits, an AI account is logged in", {
        released: released.length,
      });
    }
    return released.length;
  };

  if (deps.signedIn && deps.accounts.onChanged) {
    const signedIn = deps.signedIn;
    deps.accounts.onChanged(() => {
      const now = signedIn();
      if (!now.anthropic && !now.openai) return;
      void releaseCredits().catch((error: unknown) =>
        log.warn("taking chats off Rome credits failed", { error: String(error) }),
      );
    });
  }

  return {
    async beforeDefaultChange(change) {
      if (change.moveExisting) {
        const released = await deps.webchatRepo.releaseKeptChats();
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
        await keepOn(
          chat.id,
          row?.agentName ?? null,
          chat.largeModelSelection,
          provider,
          row?.romeCredits === true,
        );
      }
      log.info("chats kept on the old default", { provider, chats: chats.length });
    },
    async keep(chatId, provider) {
      const chat = await deps.webchatRepo.getSession(chatId);
      if (!chat) return null;
      if (provider === "rome_credits") {
        // Only this chat spends them; its model and who chose it stay.
        await deps.webchatRepo.updateSessionRomeCredits(chatId, true);
        const stored = isModelSelectionId(chat.largeModelSelection)
          ? chat.largeModelSelection
          : null;
        deps.selectModel(chatId, chat.agentName ?? null, stored, true);
        return stored;
      }
      if (chat.largeModelSelectionBy === "owner") return null;
      if (chat.largeModelSelection && chat.largeModelSelectionBy === null) return null;
      return await keepOn(
        chatId,
        chat.agentName ?? null,
        chat.largeModelSelection,
        providerOfDefault(provider),
        chat.romeCredits === true,
      );
    },
    releaseCredits,
    async follow(chatId) {
      const chat = await deps.webchatRepo.getSession(chatId);
      if (!chat) return;
      if (chat.romeCredits) {
        await deps.webchatRepo.updateSessionRomeCredits(chatId, false);
        deps.selectModel(
          chatId,
          chat.agentName ?? null,
          isModelSelectionId(chat.largeModelSelection) ? chat.largeModelSelection : null,
          false,
        );
      }
      if (chat.largeModelSelectionBy !== "kept") return;
      await deps.webchatRepo.updateSessionLargeModelSelection(
        chatId,
        chat.largeModelSelection,
        "auto",
      );
    },
    async followingCount() {
      const [following, kept] = await Promise.all([
        deps.webchatRepo.followingChats(),
        deps.webchatRepo.keptChatCount(),
      ]);
      return following.length + kept;
    },
  };
}
