import type { AgentDefinition } from "./agent-definition.js";
import type { ModelReasoningEffort } from "./model-port.js";
import type { ModelSelection } from "./model-selection.js";

/** Port. What a chat set for its sessions. */
export interface SessionSettings {
  /**
   * The model saved by the web chat whose own session this is, or null when
   * that chat leaves the choice to Rome or the session is no web chat's own.
   */
  savedModelSelection(sessionId: string): Promise<ModelSelection | null>;
  /**
   * The effort saved by the web chat whose own session this is, or null when
   * that chat saved none or the session is no web chat's own.
   */
  savedReasoningEffort(sessionId: string): Promise<ModelReasoningEffort | null>;
}

/**
 * Whether a cold resume restores the model the chat saved: when this open
 * selects no model itself. The pin no longer holds a session on another
 * provider, so the chat's exact selection outranks it on every agent, and an
 * agent that lets it (`savedSelectionOutranksPin`) changes nothing more.
 */
export function restoresSavedSelection(
  _agent: Pick<AgentDefinition, "savedSelectionOutranksPin">,
  resume: { pinned: boolean; selected: boolean },
): boolean {
  return !resume.selected;
}
