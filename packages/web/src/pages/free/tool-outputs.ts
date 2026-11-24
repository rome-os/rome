import { createContext, useContext } from "react";

/**
 * The tool pane's Outputs tab, offered to the chat beside it: the files the
 * chat's agent wrote or showed, each of which opens in a tab of its own. Like
 * the Tasks tab they are ephemeral, never part of the saved layout; there is
 * at most one Outputs tab, and one tab per file. Their bodies are the pane's own.
 * docs/domains/chats.md#outputs
 */
export interface ToolOutputsHost {
  /** Whether the tab is showing in an open pane. */
  active: boolean;
  /**
   * Whether the pane takes the whole width (a narrow window), where the chat
   * hides while the pane shows, so the caller opens the list another way.
   */
  compact: boolean;
  /**
   * Adds the tab for chat `chatId`'s outputs and selects it, or, given one of
   * its outputs, opens that file in a tab of its own and selects that. A
   * collapsed pane shows it without saving a change to its state.
   */
  show: (chatId: string, file?: OutputsTabFile, options?: OutputsTabOptions) => void;
  /** Removes the tab and every file tab. */
  hide: () => void;
}

/** The output a file tab opens, as it was when it was chosen. */
export interface OutputsTabFile {
  id: string;
  /** Names the tab. */
  name: string;
  /** Finds the file again once the agent writes it anew under another record. */
  link: string | null;
}

/** What the Outputs tab needs to know about its chat. */
export interface OutputsTabOptions {
  /** A Concierge chat, whose list also grows as its task chats work. */
  taskChats?: boolean;
}

export const ToolOutputsContext = createContext<ToolOutputsHost | null>(null);

/** The tool pane's Outputs tab, or null outside a tool workspace. */
export function useToolOutputs(): ToolOutputsHost | null {
  return useContext(ToolOutputsContext);
}
