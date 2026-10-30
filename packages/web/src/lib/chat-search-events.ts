/**
 * Asks the chat search dialog to open. The dialog's host owns the open state,
 * so a control anywhere in the shell opens it without the shell rendering.
 */
export const OPEN_CHAT_SEARCH_EVENT = "rome:open-chat-search";

export function openChatSearch(): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(OPEN_CHAT_SEARCH_EVENT));
}
