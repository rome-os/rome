import { createContext, useContext } from "react";

/**
 * The tool pane's Chat thread tab, offered to the Concierge chat beside it.
 * Like the Trace tab it is ephemeral: never part of the saved layout, and at
 * most one exists. Its body is the chat's own, drawn into `outlet`.
 */
export interface ToolThreadHost {
  /** Element inside the tab's panel, or null while no tab is mounted. */
  outlet: HTMLElement | null;
  /**
   * Shows the tab for `owner` and selects it, also when it already shows. A
   * collapsed pane shows it without saving a change to its state. `onClose`
   * runs when the tab's X or Delete key closes it, and the owner then calls
   * `close`. There is one tab for the whole pane, so the last owner to open
   * one wins: the previous owner's `onClose` runs.
   */
  open: (owner: string, onClose: () => void) => void;
  /** Removes the tab. Ignored from an owner that does not hold it. */
  close: (owner: string) => void;
}

export const ToolThreadContext = createContext<ToolThreadHost | null>(null);

/** The tool pane's Chat thread tab, or null outside a tool workspace. */
export function useToolThread(): ToolThreadHost | null {
  return useContext(ToolThreadContext);
}
