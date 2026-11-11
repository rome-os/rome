// Reads what a chat set for its sessions: the model a web chat saved, from
// the web chat side.

import type { WebChatRepository } from "./repository.js";
import { findOwnWebChat } from "../core/session-conversation.js";
import { isModelSelectionId, MODEL_SELECTIONS, type ModelSelection } from "../agent/index.js";
import type { SessionSettings } from "../agent/index.js";

export interface ChatSessionSettingsDeps {
  /** Absent, no web chat has a saved model. */
  webchatRepo?: Pick<WebChatRepository, "continuityKeyOfSession" | "getSession">;
}

export class ChatSessionSettings implements SessionSettings {
  constructor(private readonly deps: ChatSessionSettingsDeps) {}

  async savedModelSelection(sessionId: string): Promise<ModelSelection | null> {
    if (!this.deps.webchatRepo) return null;
    const saved = (await findOwnWebChat(this.deps.webchatRepo, sessionId))?.largeModelSelection;
    // Anything else, "auto" included, leaves the choice to Rome.
    return isModelSelectionId(saved) ? MODEL_SELECTIONS[saved] : null;
  }
}
