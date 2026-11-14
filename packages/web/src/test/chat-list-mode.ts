import { loadChatListModeFromStorage } from "@/lib/chat-list-mode";

/** What the chat list's mode and last ordinary chat are stored under. */
export const MODE_KEY = "rome-chat-list-mode";
export const LAST_CHAT_KEY = "rome-last-ordinary-chat";

/** Starts a tab on a device that stored these, as a page load reads them. Clear localStorage first to drop earlier ones. */
export function seedChatListMode(stored: { mode?: string; lastChat?: string } = {}): void {
  if (stored.mode) localStorage.setItem(MODE_KEY, stored.mode);
  if (stored.lastChat) localStorage.setItem(LAST_CHAT_KEY, stored.lastChat);
  loadChatListModeFromStorage();
}
