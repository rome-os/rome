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
  /**
   * Adds the tab for Concierge chat `chatId`'s tasks and selects it. A
   * collapsed pane shows it without saving a change to its state.
   */
  show: (chatId: string) => void;
  /** Removes the tab, and the task chat tab beside it. */
  hide: () => void;
  /**
   * Opens task chat `taskChatId` in the Chat tab beside Concierge chat
   * `chatId`'s Tasks tab, in place of the task chat it showed. Absent where
   * the pane cannot sit beside the chat: the caller then opens the task chat
   * as its page. `name` names the tab until the chat's own name is read.
   */
  openTask?: (chatId: string, taskChatId: string, name?: string) => void;
}

export const ToolTasksContext = createContext<ToolTasksHost | null>(null);

/** The tool pane's Tasks tab, or null outside a tool workspace. */
export function useToolTasks(): ToolTasksHost | null {
  return useContext(ToolTasksContext);
}

/** A task chat open in the side pane's Chat tab, beside its Concierge chat. */
export interface TaskChatInPane {
  /** Whether it is on screen: the Chat tab chosen, in an open pane. */
  active: boolean;
  /** Closes the Chat tab, as deleting the chat does. */
  onClose: () => void;
  /**
   * Element in the pane's tab row for the task chat's own buttons, its ⋯
   * menu: the tab is its header. Null while the tab is not the one showing.
   */
  actions: HTMLElement | null;
}

export const TaskChatInPaneContext = createContext<TaskChatInPane | null>(null);

/** The Chat tab around a task chat open in it, or null for a chat anywhere else. */
export function useTaskChatInPane(): TaskChatInPane | null {
  return useContext(TaskChatInPaneContext);
}
