import { createContext, useContext } from "react";

/** What a thread owner tells the tool pane about the Chat thread tab. */
export interface ToolThreadTab {
  /** The task's title, which names the tab. Empty while it is unknown. */
  title: string;
  /** The thread's task chat, which the pane's header opens, or null when none is known. */
  taskChatId: string | null;
  /** Closes the thread in its owner. The tab's X and Delete key call it. */
  onClose: () => void;
}

/**
 * The tool pane's Chat thread tab, offered to the Concierge chat beside it.
 * Like the Trace tab it is ephemeral: never part of the saved layout, and at
 * most one exists. Its body is the chat's own, drawn into `outlet`.
 */
export interface ToolThreadHost {
  /** Element inside the tab's panel, or null while no tab is mounted. */
  outlet: HTMLElement | null;
  /**
   * Shows the tab for `owner`, or removes it with `null`. Idempotent for the
   * same arguments, and `null` from a non-owner is ignored. A new tab is
   * selected. There is one tab for the whole pane, so the last owner to show
   * one wins: the previous owner's `onClose` runs.
   */
  set: (owner: string, tab: ToolThreadTab | null) => void;
  /**
   * Selects the tab. A collapsed pane shows it without changing the session's
   * saved pane state. Call it when the user asks to open a thread, including
   * one that is already open.
   */
  reveal: () => void;
}

export const ToolThreadContext = createContext<ToolThreadHost | null>(null);

/** The tool pane's Chat thread tab, or null outside a tool workspace. */
export function useToolThread(): ToolThreadHost | null {
  return useContext(ToolThreadContext);
}
