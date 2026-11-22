// Reads what a chat set for its sessions: the model and the effort a web chat
// saved, from the web chat side.

import type { WebChatRepository } from "./repository.js";
import { findOwnWebChat } from "../core/session-conversation.js";
import {
  isModelSelectionId,
  MODEL_SELECTIONS,
  type ModelSelection,
  type ModelSelectionId,
} from "../agent/index.js";
import type { ModelReasoningEffort, SessionSettings } from "../agent/index.js";
import { REASONING_EFFORT_VALUES } from "@rome-os/app-runtime";

export interface ChatSessionSettingsDeps {
  /** Absent, no web chat has a saved model or effort. */
  webchatRepo?: Pick<WebChatRepository, "continuityKeyOfSession" | "getSession">;
  /**
   * The model a chat Rome chose a model for runs now: the default provider's
   * of the same strength. Absent, the saved model stays.
   */
  follow?: (saved: ModelSelectionId) => ModelSelectionId;
}

export class ChatSessionSettings implements SessionSettings {
  constructor(private readonly deps: ChatSessionSettingsDeps) {}

  async savedModelSelection(sessionId: string): Promise<ModelSelection | null> {
    if (!this.deps.webchatRepo) return null;
    const chat = await findOwnWebChat(this.deps.webchatRepo, sessionId);
    const saved = chat?.largeModelSelection;
    // Anything else, "auto" included, leaves the choice to Rome.
    if (!isModelSelectionId(saved)) return null;
    // A model Rome chose follows the default provider; one its owner picked stays.
    const id =
      chat?.largeModelSelectionBy === "auto" && this.deps.follow ? this.deps.follow(saved) : saved;
    return MODEL_SELECTIONS[id];
  }

  async savedReasoningEffort(sessionId: string): Promise<ModelReasoningEffort | null> {
    if (!this.deps.webchatRepo) return null;
    const saved = (await findOwnWebChat(this.deps.webchatRepo, sessionId))?.reasoningEffort;
    return REASONING_EFFORT_VALUES.find((effort) => effort === saved) ?? null;
  }
}
