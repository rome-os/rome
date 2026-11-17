import { createContext, useContext } from "react";

/**
 * The tool pane's Memory tab: the memory browser, offered to the Concierge
 * chat beside it. Like the Tasks tab it is ephemeral, never part of the saved
 * layout, and at most one exists.
 */
export interface ToolMemoryHost {
  /**
   * Whether the pane takes the whole width (a narrow window), where the chat
   * hides while the pane shows, so the caller opens memory another way.
   */
  compact: boolean;
  /** Adds the tab and selects it. A collapsed pane shows it without saving a change to its state. */
  show: () => void;
  /** Removes the tab. */
  hide: () => void;
}

export const ToolMemoryContext = createContext<ToolMemoryHost | null>(null);

/** The tool pane's Memory tab, or null outside a tool workspace. */
export function useToolMemory(): ToolMemoryHost | null {
  return useContext(ToolMemoryContext);
}
