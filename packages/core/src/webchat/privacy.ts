// Which dashboard chats are a Concierge's, and who may open them. A leaf
// module, so the chat, action and storage layers can ask without loading the
// Concierge.

import { CONCIERGE_CHAT_ID } from "@rome/api-types/concierge";
import { type SQL, sql } from "drizzle-orm";
import { type ConciergeOwner, mainChatIdOf, ownerOf } from "./owner.js";

/** The canonical id of the core agent behind the Concierge conversation. */
export const CONCIERGE_AGENT_ID = "core:concierge";
/** `rome_sessions.trigger_kind` of a task chat Concierge started. */
export const TASK_CHAT_TRIGGER_KIND = "concierge";
/**
 * `rome_sessions.trigger_kind` of a child session (a fork, a subagent) of a
 * private chat, marked when it is made, so it stays private to that chat's
 * owner after the chat it came from is gone.
 */
export const PRIVATE_CHILD_TRIGGER_KIND = "concierge_fork";

export function isConciergeAgent(agentName: string | null | undefined): boolean {
  return agentName === CONCIERGE_AGENT_ID || agentName === "concierge";
}

/** Whether a dashboard chat is a Concierge chat: the main chat, or a topic chat. */
export function isConciergeChat(
  chat: { id: string; agentName?: string | null } | null | undefined,
): boolean {
  return !!chat && (chat.id === CONCIERGE_CHAT_ID || isConciergeAgent(chat.agentName));
}

/**
 * The one person a chat is private to: a Concierge chat's owner, the owner of
 * a task chat a Concierge started, and the owner of a child session of either
 * (a fork, a subagent). Null for any other chat, which every dashboard user
 * may open.
 */
export function privateOwnerOf(
  chat:
    | {
        id: string;
        agentName?: string | null;
        ownerKey?: string | null;
        triggerKind?: string | null;
      }
    | null
    | undefined,
): ConciergeOwner | null {
  if (!chat) return null;
  if (
    isConciergeChat(chat) ||
    chat.triggerKind === TASK_CHAT_TRIGGER_KIND ||
    chat.triggerKind === PRIVATE_CHILD_TRIGGER_KIND
  ) {
    return ownerOf(chat);
  }
  return null;
}

/** Whether a chat is its owner's main Concierge chat. */
export function isMainConciergeChat(chat: {
  id: string;
  agentName?: string | null;
  ownerKey?: string | null;
}): boolean {
  return isConciergeChat(chat) && chat.id === mainChatIdOf(ownerOf(chat));
}

/** What the privacy check reads of a chat. */
export interface ChatPrivacyRow {
  id: string;
  agentName?: string | null;
  ownerKey?: string | null;
  triggerKind?: string | null;
}

/**
 * The one privacy policy for dashboard chats, read off the chat's own row:
 * a private chat opens only for its owner, and any other chat for everyone.
 * A child session inherits its parent's privacy when it is made, so no path
 * needs to look past the row.
 */
export function canOpen(chat: ChatPrivacyRow | null | undefined, owner: string | null): boolean {
  const privateTo = privateOwnerOf(chat);
  return privateTo === null || privateTo === owner;
}

/**
 * Whether `owner` may open chat `chatId`. It fails closed: only a chat that
 * exists and passes {@link canOpen} is open, and one that cannot be found is
 * not found to anyone.
 */
export async function canOpenChat(
  getSession: (id: string) => Promise<ChatPrivacyRow | null>,
  chatId: string,
  owner: string | null,
): Promise<boolean> {
  const chat = await getSession(chatId);
  return chat !== null && canOpen(chat, owner);
}

/** The columns of a chat row the policy reads, for a query to filter by. */
export interface ChatPrivacyColumns {
  id: SQL | unknown;
  agentName: SQL | unknown;
  ownerKey: SQL | unknown;
  triggerKind: SQL | unknown;
}

/**
 * {@link canOpen} as a query condition: the chats `owner` may open. A list or
 * a search filters with it before it counts, limits or reads a message.
 */
export function canOpenSql(chat: ChatPrivacyColumns, owner: string | null): SQL {
  const isPrivate = sql`(${chat.id} = ${CONCIERGE_CHAT_ID}
    OR coalesce(${chat.agentName}, '') IN (${CONCIERGE_AGENT_ID}, 'concierge')
    OR coalesce(${chat.triggerKind}, '') IN (${TASK_CHAT_TRIGGER_KIND}, ${PRIVATE_CHILD_TRIGGER_KIND}))`;
  return owner === null
    ? sql`NOT ${isPrivate}`
    : sql`(NOT ${isPrivate} OR coalesce(${chat.ownerKey}, 'guardian') = ${owner})`;
}
