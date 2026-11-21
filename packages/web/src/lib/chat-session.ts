import type { ChatSession } from "@/lib/chat-types";

/** The canonical id of the agent behind every Concierge chat. */
export const CONCIERGE_AGENT_ID = "core:concierge";
/** `triggerKind` of a task chat the Concierge started. */
export const TASK_CHAT_TRIGGER_KIND = "concierge";

/**
 * What a dashboard chat is, in the words of docs/domains/chats.md. A fork of
 * a Concierge chat still runs on the Concierge, so it is a topic chat. Only a
 * fork of a common chat or of a fork chat is a fork chat.
 */
export type ChatKind = "main" | "topic" | "task" | "fork" | "common";

/**
 * Classifies a chat. Without `mainChatId`, the main chat reads as a topic
 * chat, which every caller treats the same way except to name it.
 */
export function chatKind(
  session: Pick<ChatSession, "id" | "agentName" | "triggerKind" | "parentSessionId">,
  mainChatId?: string | null,
): ChatKind {
  if (mainChatId && session.id === mainChatId) return "main";
  if (session.triggerKind === TASK_CHAT_TRIGGER_KIND) return "task";
  if (session.agentName === CONCIERGE_AGENT_ID) return "topic";
  if (session.parentSessionId) return "fork";
  return "common";
}

/**
 * Whether a chat is a common chat or a fork chat: one that sits under
 * Projects in the chat list, and whose turns can be forked.
 */
export function isProjectChat(kind: ChatKind): boolean {
  return kind === "common" || kind === "fork";
}

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
