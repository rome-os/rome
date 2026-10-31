import { createContext, useContext } from "react";

/**
 * The tool pane's Tasks tab, offered to the Concierge chat beside it. Like the
 * Trace tab it is ephemeral: never part of the saved layout, and at most one
 * exists. Unlike the Trace tab its body is the pane's own, so the chat only
 * asks for it to show or hide.
 */
export interface ToolTasksHost {
  /** Whether the tab is showing in an open pane. */
  active: boolean;
  /**
   * Whether the pane takes the whole width (a narrow window), where the chat
   * hides while the pane shows. The tab would hide the chat it belongs to, so
   * the caller opens the list another way.
   */
  compact: boolean;
  /** Adds the tab and selects it. A collapsed pane shows it without saving a change to its state. */
  show: () => void;
  /** Removes the tab. */
  hide: () => void;
}

export const ToolTasksContext = createContext<ToolTasksHost | null>(null);

/** The tool pane's Tasks tab, or null outside a tool workspace. */
export function useToolTasks(): ToolTasksHost | null {
  return useContext(ToolTasksContext);
}
