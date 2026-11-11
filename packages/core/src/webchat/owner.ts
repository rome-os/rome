// Whose Concierge a chat is. Each person on the dashboard has their own
// Concierge (rome-os/rome#1478): the owner lives only on the Concierge chat,
// as every dashboard chat records it, and a chat with no owner is the
// guardian's. Everything else reaches its owner through the chat it reports to.

import { createHash } from "node:crypto";
import { CONCIERGE_CHAT_ID } from "@rome/api-types/concierge";

/** An owner, as a dashboard chat records it: "guardian" or "visitor:<account>". */
export type ConciergeOwner = string;

export const GUARDIAN_OWNER: ConciergeOwner = "guardian";

const VISITOR_OWNER_PREFIX = "visitor:";

/** The Rome Cloud account a push for `owner` names: a visitor's, or undefined for the guardian. */
export function recipientOf(owner: ConciergeOwner): string | undefined {
  return owner.startsWith(VISITOR_OWNER_PREFIX)
    ? owner.slice(VISITOR_OWNER_PREFIX.length)
    : undefined;
}

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

/** The name a main chat is created with. A client labels it by `main: true`. */
export const MAIN_CHAT_NAME = "Main chat";

/**
 * The id of an owner's main Concierge chat. The guardian's is the fixed
 * `concierge`. A visitor's is derived from their owner key, since a chat id
 * may hold neither ":" (session keys are split on it) nor anything a live
 * topic name refuses.
 */
export function mainChatIdOf(owner: ConciergeOwner): string {
  if (owner === GUARDIAN_OWNER) return CONCIERGE_CHAT_ID;
  return `concierge-v-${createHash("sha256").update(owner).digest("hex").slice(0, 24)}`;
}

/** How a chat a row reports to is stored: null for the guardian's main chat. */
export function storedChatId(chatId: string): string | null {
  return chatId === CONCIERGE_CHAT_ID ? null : chatId;
}
