import { createContext, useContext } from "react";

/**
 * The tool pane's Outputs tab, offered to the chat beside it: the files the
 * chat's agent wrote or showed. Like the Tasks tab it is ephemeral, never part
 * of the saved layout, and at most one exists; its body is the pane's own.
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
   * Adds the tab for chat `chatId`'s outputs and selects it, previewing output
   * `outputId` when one is given. A collapsed pane shows it without saving a
   * change to its state.
   */
  show: (chatId: string, outputId?: string) => void;
  /** Removes the tab. */
  hide: () => void;
}

export const ToolOutputsContext = createContext<ToolOutputsHost | null>(null);

/** The tool pane's Outputs tab, or null outside a tool workspace. */
export function useToolOutputs(): ToolOutputsHost | null {
  return useContext(ToolOutputsContext);
}
