// Which dashboard chats are a Concierge's, and whose. A leaf
// module, so the chat, action and storage layers can ask without loading the
// Concierge.

import { CONCIERGE_CHAT_ID } from "@rome/api-types/concierge";
import { type SQL, sql } from "drizzle-orm";
import type { ChildSessionInheritance } from "../sessions/session-records.js";
import { type ConciergeOwner, ownerOf } from "./owner.js";

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

/** A child session of a private chat is marked private to its owner. */
export const privateChildren: ChildSessionInheritance = {
  triggerKindUnder: (parent) =>
    privateOwnerOf(parent) !== null ? PRIVATE_CHILD_TRIGGER_KIND : null,
};

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

/** What the privacy check reads of a chat. */
export interface ChatPrivacyRow {
  id: string;
  agentName?: string | null;
  ownerKey?: string | null;
  triggerKind?: string | null;
}

/** Whether a chat is in what Rome shows `owner`: any chat but another person's
 * Concierge or task chat. Resuming a session by its id asks this until the
 * audience of a session goes (rome-os/rome#2722). */
export function canOpen(chat: ChatPrivacyRow | null | undefined, owner: string | null): boolean {
  const privateTo = privateOwnerOf(chat);
  return privateTo === null || privateTo === owner;
}

/** The columns of a chat row {@link shownSql} reads. */
export interface ShownColumns {
  id: SQL | unknown;
  agentName: SQL | unknown;
  ownerKey: SQL | unknown;
  triggerKind: SQL | unknown;
}

/**
 * The chats a list or a search shows `owner`, as a query condition: every
 * common chat, and their own Concierge and task chats. Anyone opens any chat
 * by its id.
 */
export function shownSql(chat: ShownColumns, owner: string | null): SQL {
  const isConcierges = sql`(${chat.id} = ${CONCIERGE_CHAT_ID}
    OR coalesce(${chat.agentName}, '') IN (${CONCIERGE_AGENT_ID}, 'concierge')
    OR coalesce(${chat.triggerKind}, '') IN (${TASK_CHAT_TRIGGER_KIND}, ${PRIVATE_CHILD_TRIGGER_KIND}))`;
  return owner === null
    ? sql`NOT ${isConcierges}`
    : sql`(NOT ${isConcierges} OR coalesce(${chat.ownerKey}, 'guardian') = ${owner})`;
}
