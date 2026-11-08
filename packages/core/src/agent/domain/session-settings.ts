import type { ChatRef, ProviderSessionResetPolicy } from "@rome-os/app-runtime";
import type { AgentDefinition } from "./agent-definition.js";
import type { ModelSelection } from "./model-selection.js";

/** Port. What a chat set for the sessions it opens. */
export interface SessionSettings {
  /** When chat `chat` starts its agent on a fresh session, or null when it sets nothing and no reset is checked. */
  resetPolicy(chat: ChatRef): Promise<ProviderSessionResetPolicy | null>;
  /** The model web chat `chatId` saved, or null when it leaves the choice to Rome or is not a web chat. */
  savedModelSelection(chatId: string): Promise<ModelSelection | null>;
}

/**
 * Whether a cold resume restores the model the chat saved: only when this open
 * selects no model itself, and the session is pinned to none or its agent lets
 * the saved selection outrank the pin.
 */
export function restoresSavedSelection(
  agent: Pick<AgentDefinition, "savedSelectionOutranksPin">,
  resume: { pinned: boolean; selected: boolean },
): boolean {
  return !resume.selected && (!resume.pinned || agent.savedSelectionOutranksPin === true);
}
