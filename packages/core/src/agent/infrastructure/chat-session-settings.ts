// Reads what a chat set for its sessions: the reset policy from chat settings,
// and the model a web chat saved from the web chat repository.

import type { ChatRef, ProviderSessionResetPolicy } from "@rome-os/app-runtime";
import { resolveWebchatLargeModelSelection } from "../../core/model-selector.js";
import type { WebChatRepository } from "../../db/repositories/webchat.js";
import type { ModelSelection } from "../domain/model-selection.js";
import type { SessionSettings } from "../domain/session-settings.js";

export interface ChatSessionSettingsDeps {
  /** The reset policy in effect for a chat. Absent, no chat sets one. */
  resetPolicy?: (chat: ChatRef) => Promise<ProviderSessionResetPolicy>;
  /** Absent, no web chat has a saved model. */
  webchatRepo?: Pick<WebChatRepository, "getSession">;
}

export class ChatSessionSettings implements SessionSettings {
  constructor(private readonly deps: ChatSessionSettingsDeps) {}

  async resetPolicy(chat: ChatRef): Promise<ProviderSessionResetPolicy | null> {
    return this.deps.resetPolicy ? await this.deps.resetPolicy(chat) : null;
  }

  async savedModelSelection(chatId: string): Promise<ModelSelection | null> {
    const chat = await this.deps.webchatRepo?.getSession(chatId);
    return resolveWebchatLargeModelSelection(chat?.largeModelSelection);
  }
}
