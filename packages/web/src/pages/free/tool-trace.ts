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
  /**
   * Expands the pane if it is collapsed and selects the Trace tab. Call it
   * when the user asks to open a trace, including one that is already open.
   */
  reveal: () => void;
  /**
   * Shows the Trace tab for `owner`, or removes it with `null`. Idempotent for
   * the same arguments, and `null` from a non-owner is ignored. A second owner
   * displaces the first by calling its `onClose`.
   */
  set: (owner: string, tab: ToolTraceTab | null) => void;
}

export const ToolTraceContext = createContext<ToolTraceHost | null>(null);

/** The pane's Trace tab, or null outside a tool workspace. */
export function useToolTrace(): ToolTraceHost | null {
  return useContext(ToolTraceContext);
}
