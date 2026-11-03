import { createContext, useContext } from "react";

/** What a trace owner tells the tool pane about the Trace tab. */
export interface ToolTraceTab {
  /** Shows the Live indicator on the tab. */
  streaming: boolean;
  /** Closes the trace in its owner. The tab's X and Delete key call it. */
  onClose: () => void;
}

/**
 * The tool pane's Trace tab, offered to the chat beside it. The tab is
 * ephemeral: never part of the saved layout, and at most one exists.
 */
export interface ToolTraceHost {
  /** Element inside the Trace tab's panel, or null while no tab is mounted. */
  outlet: HTMLElement | null;
  /** Whether the pane is showing, counting a pane a trace holds open. */
  paneOpen: boolean;
  /**
   * Expands or collapses the pane for real, as a user's toggle. Expanding keeps
   * a Trace tab that is selected; collapsing keeps the tab for later.
   */
  setPaneCollapsed: (collapsed: boolean) => void;
  /**
   * Selects the Trace tab. A collapsed pane shows it without changing the
   * session's saved pane state, and goes back to that state when the trace
   * ends. Call it when the user asks to open a trace, including one that is
   * already open.
   */
  reveal: () => void;
  /**
   * Shows the Trace tab for `owner`, or removes it with `null`. Idempotent for
   * the same arguments, and `null` from a non-owner is ignored. There is one
   * Trace tab for the whole pane, so the last owner to open a trace wins: a
   * pinned side chat opening a trace replaces the main chat's, by calling the
   * main chat's `onClose`, and the reverse holds too.
   */
  set: (owner: string, tab: ToolTraceTab | null) => void;
}

export const ToolTraceContext = createContext<ToolTraceHost | null>(null);

/** The tool pane's controls. Throws outside a tool workspace. */
export function useToolTrace(): ToolTraceHost {
  const host = useContext(ToolTraceContext);
  if (!host) throw new Error("useToolTrace must be used within a ToolWorkspace");
  return host;
}
