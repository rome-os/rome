import type { ChatSession } from "@/lib/chat-types";

/** Where the signed-in person's main Concierge chat opens. Topic chats are at `/chat/<id>`. */
export const MAIN_CHAT_PATH = "/message";

/** The path that opens chat `id`: the main chat's own path when it is `mainChatId`. */
export function chatPath(id: string, mainChatId?: string | null): string {
  return id === mainChatId ? MAIN_CHAT_PATH : `/chat/${encodeURIComponent(id)}`;
}

/** Whether `pathname` is a chat page: a new chat, an open one, or the main Concierge chat. */
export function isChatPath(pathname: string): boolean {
  return pathname === "/chat" || pathname.startsWith("/chat/") || pathname === MAIN_CHAT_PATH;
}

/**
 * The id of the chat open at `pathname`, if any. The main chat's path carries
 * no id, so `/message` is `mainChatId`, and null while that is not known.
 */
export function activeSessionFromPath(
  pathname: string,
  mainChatId: string | null = null,
): string | null {
  if (pathname === MAIN_CHAT_PATH) return mainChatId;
  const match = pathname.match(/^\/chat\/([^/?#]+)/);
  if (!match) return null;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return match[1];
  }
}

export function sessionActivityTime(session: ChatSession): number {
  return new Date(session.activityAt).getTime();
}
