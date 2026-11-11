// Whose Concierge a chat is. Each person on the dashboard has their own
// Concierge (rome-os/rome#1478): the owner lives only on the Concierge chat,
// as every dashboard chat records it, and a chat with no owner is the
// guardian's. Everything else reaches its owner through the chat it reports to.

import { CONCIERGE_CHAT_ID } from "@rome/api-types/concierge";

/** An owner, as a dashboard chat records it: "guardian" or "visitor:<account>". */
export type ConciergeOwner = string;

export const GUARDIAN_OWNER: ConciergeOwner = "guardian";

/** A chat's owner: the one it records, the guardian when it records none. */
export function ownerOf(chat: { ownerKey?: string | null }): ConciergeOwner {
  return chat.ownerKey || GUARDIAN_OWNER;
}

/** The owner of dashboard chat `chatId`, or null when there is no such chat. */
export async function ownerOfChat(
  getSession: (id: string) => Promise<{ ownerKey?: string | null } | null>,
  chatId: string,
): Promise<ConciergeOwner | null> {
  const chat = await getSession(chatId);
  return chat ? ownerOf(chat) : null;
}

/** How a chat a row reports to is stored: null for the guardian's main chat. */
export function storedChatId(chatId: string): string | null {
  return chatId === CONCIERGE_CHAT_ID ? null : chatId;
}
