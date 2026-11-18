// Reads what a chat set for its sessions: the model and the effort a web chat
// saved, from the web chat side.

import type { WebChatRepository } from "./repository.js";
import { findOwnWebChat } from "../core/session-conversation.js";
import { isModelSelectionId, MODEL_SELECTIONS, type ModelSelection } from "../agent/index.js";
import type { ModelReasoningEffort, SessionSettings } from "../agent/index.js";
import { REASONING_EFFORT_VALUES } from "@rome-os/app-runtime";

export interface ChatSessionSettingsDeps {
  /** Absent, no web chat has a saved model or effort. */
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

  async savedReasoningEffort(sessionId: string): Promise<ModelReasoningEffort | null> {
    if (!this.deps.webchatRepo) return null;
    const saved = (await findOwnWebChat(this.deps.webchatRepo, sessionId))?.reasoningEffort;
    return REASONING_EFFORT_VALUES.find((effort) => effort === saved) ?? null;
  }
}
