import type { AgentDefinition } from "./agent-definition.js";
import type { ModelSelection } from "./model-selection.js";

/** Port. What a chat set for its sessions. */
export interface SessionSettings {
  /**
   * The model saved by the web chat whose own session this is, or null when
   * that chat leaves the choice to Rome or the session is no web chat's own.
   */
  savedModelSelection(sessionId: string): Promise<ModelSelection | null>;
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
