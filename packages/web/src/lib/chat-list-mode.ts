import { type ChatKind, isProjectChat, MAIN_CHAT_PATH } from "@/lib/chat-session";
import { isApplePlatform } from "@/lib/platform";

/**
 * Which half of the chat list shows: ordinary chats grouped by project, or the
 * Concierge's main chat, topic chats and task chats.
 */
export type ChatListMode = "chat" | "concierge";

const MODE_STORAGE_KEY = "rome-chat-list-mode";
const LAST_CHAT_STORAGE_KEY = "rome-last-ordinary-chat";

const listeners = new Set<() => void>();

/** Calls `listener` when the mode or the last ordinary chat changes, in this tab or another. */
export function subscribeChatListMode(listener: () => void): () => void {
  listeners.add(listener);
  const onStorage = (event: StorageEvent) => {
    if (event.key === MODE_STORAGE_KEY || event.key === LAST_CHAT_STORAGE_KEY) listener();
  };
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("storage", onStorage);
  };
}

function read(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function write(key: string, value: string): void {
  try {
    if (window.localStorage.getItem(key) === value) return;
    window.localStorage.setItem(key, value);
  } catch {
    // Storage is unavailable: the choice holds for this page load only.
  }
  for (const listener of listeners) listener();
}

/** The mode this device last showed, or null before it has shown one. */
export function readChatListMode(): ChatListMode | null {
  const raw = read(MODE_STORAGE_KEY);
  return raw === "chat" || raw === "concierge" ? raw : null;
}

export function writeChatListMode(mode: ChatListMode): void {
  write(MODE_STORAGE_KEY, mode);
}

/** The ordinary chat last opened on this device, or null. */
export function readLastOrdinaryChatId(): string | null {
  return read(LAST_CHAT_STORAGE_KEY) || null;
}

export function writeLastOrdinaryChatId(id: string): void {
  write(LAST_CHAT_STORAGE_KEY, id);
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
