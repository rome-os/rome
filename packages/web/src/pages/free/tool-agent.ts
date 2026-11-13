import { createContext, useContext } from "react";

/** What the Agent tab shows: which Concierge chat's work, and where a picked use goes. */
export interface ToolAgentView {
  /** The Concierge chat whose work the Work tab lists. */
  chatId: string;
  /** A use was picked: its prompt goes in that chat's message box, unsent. */
  onUse: (prompt: string) => void;
}

/**
 * The tool pane's Agent tab, offered to the Concierge chat beside it. Like the
 * Trace tab it is ephemeral: never part of the saved layout, and at most one
 * exists. Unlike the Trace tab its body is the pane's own, so the chat only
 * asks for it to show or hide.
 */
export interface ToolAgentHost {
  /** Whether the tab is showing in an open pane. */
  active: boolean;
  /**
   * Whether the pane takes the whole width (a narrow window), where the chat
   * hides while the pane shows. The tab would hide the chat it belongs to, so
   * the caller opens the page another way.
   */
  compact: boolean;
  /** Adds the tab for `view` and selects it. A collapsed pane shows it without saving a change to its state. */
  show: (view: ToolAgentView) => void;
  /** Removes the tab. */
  hide: () => void;
}

export const ToolAgentContext = createContext<ToolAgentHost | null>(null);

/** The tool pane's Agent tab, or null outside a tool workspace. */
export function useToolAgent(): ToolAgentHost | null {
  return useContext(ToolAgentContext);
}
