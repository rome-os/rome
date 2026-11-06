// Which dashboard chats are a Concierge's, and who may open them. A leaf
// module, so the chat and action layers can ask without loading the Concierge.

import { CONCIERGE_CHAT_ID } from "@rome/api-types/concierge";
import { type ConciergeOwner, mainChatIdOf, ownerOf } from "./owner.js";

/** The canonical id of the core agent behind the Concierge conversation. */
export const CONCIERGE_AGENT_ID = "core:concierge";
/** `rome_sessions.trigger_kind` of a task chat Concierge started. */
export const TASK_CHAT_TRIGGER_KIND = "concierge";

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
 * The one person a chat is private to: a Concierge chat's owner, and the
 * owner of a task chat a Concierge started. Null for any other chat, which
 * every dashboard user may open.
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
  if (isConciergeChat(chat) || chat.triggerKind === TASK_CHAT_TRIGGER_KIND) return ownerOf(chat);
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

/** How far up a chain of forks the privacy check looks. */
const MAX_FORK_DEPTH = 8;

/**
 * Whether `owner` may open chat `chatId`: no for another owner's Concierge
 * chat or Concierge task chat, or a fork of one. Yes for any other chat,
 * and for one that does not exist, which the caller answers as it does today.
 */
export async function canOpenChat(
  getSession: (id: string) => Promise<{
    id: string;
    agentName?: string | null;
    ownerKey?: string | null;
    triggerKind?: string | null;
    parentSessionId?: string | null;
  } | null>,
  chatId: string,
  owner: string | null,
): Promise<boolean> {
  let id: string | null | undefined = chatId;
  for (let depth = 0; id && depth < MAX_FORK_DEPTH; depth++) {
    const chat = await getSession(id);
    const privateTo = privateOwnerOf(chat);
    if (privateTo !== null) return privateTo === owner;
    id = chat?.parentSessionId;
  }
  return true;
}
