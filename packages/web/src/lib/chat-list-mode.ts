import { type ChatKind, isProjectChat, MAIN_CHAT_PATH } from "@/lib/chat-session";
import { isApplePlatform } from "@/lib/platform";

/**
 * Which half of the chat list shows: ordinary chats grouped by project, or the
 * Concierge's main chat, topic chats and task chats.
 */
export type ChatListMode = "chat" | "concierge";

const MODE_STORAGE_KEY = "rome-chat-list-mode";
const LAST_CHAT_STORAGE_KEY = "rome-last-ordinary-chat";

// Each tab keeps its own mode and last ordinary chat in memory, seeded from
// localStorage when the page loads. A tab writes localStorage so that a new tab
// or a reload starts from the last mode, and never reads it again: another
// tab's navigation must not change the list this tab shows.
const state: { mode: ChatListMode | null; lastChatId: string | null } = {
  mode: null,
  lastChatId: null,
};
const listeners = new Set<() => void>();

function readStorage(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStorage(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // Storage is unavailable: the choice holds for this tab only.
  }
}

/** Seeds this tab's state from what the device stored, as a page load does. */
export function loadChatListModeFromStorage(): void {
  const mode = readStorage(MODE_STORAGE_KEY);
  state.mode = mode === "chat" || mode === "concierge" ? mode : null;
  state.lastChatId = readStorage(LAST_CHAT_STORAGE_KEY) || null;
  for (const listener of listeners) listener();
}
if (typeof window !== "undefined") loadChatListModeFromStorage();

/** Calls `listener` when this tab's mode or last ordinary chat changes. */
export function subscribeChatListMode(listener: () => void): () => void {
  listeners.add(listener);
  return () => void listeners.delete(listener);
}

/** This tab's mode, or null before the tab or its device has shown one. */
export function readChatListMode(): ChatListMode | null {
  return state.mode;
}

export function writeChatListMode(mode: ChatListMode): void {
  writeStorage(MODE_STORAGE_KEY, mode);
  if (state.mode === mode) return;
  state.mode = mode;
  for (const listener of listeners) listener();
}

/** The ordinary chat last opened in this tab or, at load, on this device; null when none. */
export function readLastOrdinaryChatId(): string | null {
  return state.lastChatId;
}

export function writeLastOrdinaryChatId(id: string): void {
  writeStorage(LAST_CHAT_STORAGE_KEY, id);
  if (state.lastChatId === id) return;
  state.lastChatId = id;
  for (const listener of listeners) listener();
}

/**
 * The mode of a device that has not shown one: Chat for someone who has
 * ordinary chats, Concierge for someone whose chats are all the Concierge's.
 */
export function initialChatListMode(hasOrdinaryChat: boolean): ChatListMode {
  return hasOrdinaryChat ? "chat" : "concierge";
}

/** The mode a chat of this kind belongs to. */
export function modeOfChatKind(kind: ChatKind): ChatListMode {
  return isProjectChat(kind) ? "chat" : "concierge";
}

export interface ChatRouteMode {
  mode: ChatListMode;
  /** Set when the route opens an ordinary chat, which the rail's Chat entry returns to. */
  ordinaryChatId?: string;
}

/**
 * The mode the open page asks for, or null when the page is not a chat or the
 * open chat's kind is not known yet. `kindOf` answers for a chat id, null
 * when the chat is not in any list the caller has.
 */
export function chatListModeForRoute({
  pathname,
  state,
  mainChatId,
  kindOf,
}: {
  pathname: string;
  state: unknown;
  mainChatId: string | null;
  kindOf: (id: string) => ChatKind | null;
}): ChatRouteMode | null {
  if (pathname === MAIN_CHAT_PATH) return { mode: "concierge" };
  if (pathname === "/chat" || pathname === "/chat/") {
    // A blank chat has no kind yet: the new-topic entry says which it is.
    const topic =
      typeof state === "object" &&
      state !== null &&
      (state as { conciergeTopic?: unknown }).conciergeTopic === true;
    return { mode: topic ? "concierge" : "chat" };
  }
  const match = pathname.match(/^\/chat\/([^/?#]+)/);
  if (!match) return null;
  let id = match[1];
  try {
    id = decodeURIComponent(id);
  } catch {
    // An id that is not valid percent-encoding is its raw text.
  }
  if (id === mainChatId) return { mode: "concierge" };
  const kind = kindOf(id);
  if (!kind) return null;
  const mode = modeOfChatKind(kind);
  return mode === "chat" ? { mode, ordinaryChatId: id } : { mode };
}

/** The address the rail's Chat entry opens: the main chat in Concierge mode, else the last ordinary chat. */
export function railChatHref(
  mode: ChatListMode,
  lastOrdinaryChatId: string | null,
  /** Whether that chat is still in the lists this tab has; true when no list is loaded to say. */
  lastOrdinaryChatExists: boolean,
): string {
  if (mode === "concierge") return MAIN_CHAT_PATH;
  return lastOrdinaryChatId && lastOrdinaryChatExists
    ? `/chat/${encodeURIComponent(lastOrdinaryChatId)}`
    : "/chat";
}

/** What the New chat row shows beside its label, for the shortcut the shell listens for. */
export function newChatShortcutForPlatform(
  platform = typeof navigator === "undefined" ? "" : navigator.platform,
): string {
  return isApplePlatform(platform) ? "⌘ ⇧ O" : "Ctrl ⇧ O";
}

/**
 * Where a new chat opens in `mode`: an ordinary blank chat, or a blank topic
 * chat. Both create nothing until the first send.
 */
export function newChatTarget(
  mode: ChatListMode,
  search = "",
): { to: string; state?: { conciergeTopic: true } } {
  return mode === "concierge"
    ? { to: `/chat${search}`, state: { conciergeTopic: true } }
    : { to: `/chat${search}` };
}
