// Which dashboard chats are a Concierge's, and who may open them. A leaf
// module, so the chat and action layers can ask without loading the Concierge.

import { CONCIERGE_CHAT_ID } from "@rome/api-types/concierge";
import { currentSessionActor, sessionOwnerKey } from "../lib/session-actor.js";
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

/** What the privacy check reads of a chat. */
export interface ChatLineageRow {
  id: string;
  agentName?: string | null;
  ownerKey?: string | null;
  triggerKind?: string | null;
  parentSessionId?: string | null;
}

/**
 * The one privacy policy for dashboard chats: a chat is private to the owner
 * of the first Concierge chat or Concierge task chat on its line of forks,
 * itself included, and open to everyone when there is none. Every path that
 * reads, lists or searches chats asks it, so a fork, even one promoted to an
 * ordinary chat, stays as private as the chat it came from.
 */
export function chatAccess(
  getRow: (id: string) => Promise<ChatLineageRow | null | undefined>,
  owner: string | null,
) {
  const privateTo = new Map<string, Promise<string | null>>();
  const lineOwner = (id: string, depth: number): Promise<string | null> => {
    const known = privateTo.get(id);
    if (known) return known;
    const found = (async () => {
      const chat = await getRow(id);
      const own = privateOwnerOf(chat);
      if (own !== null || !chat?.parentSessionId || depth >= MAX_FORK_DEPTH) return own;
      return lineOwner(chat.parentSessionId, depth + 1);
    })();
    privateTo.set(id, found);
    return found;
  };
  return {
    /** The person a chat is private to along its line of forks, or null when it is open to all. */
    privateOwner: (chatId: string) => lineOwner(chatId, 0),
    /** Whether the owner may open the chat. One that does not exist is open, and its caller answers as it does today. */
    async canOpen(chatId: string): Promise<boolean> {
      const to = await lineOwner(chatId, 0);
      return to === null || to === owner;
    },
  };
}

/** Whether `owner` may open chat `chatId`, by {@link chatAccess}. */
export function canOpenChat(
  getSession: (id: string) => Promise<ChatLineageRow | null>,
  chatId: string,
  owner: string | null,
): Promise<boolean> {
  return chatAccess(getSession, owner).canOpen(chatId);
}

/**
 * {@link chatAccess} over every chat's lineage read at once, for a list or a
 * search: the ids `owner` may not open, and a check for any one id.
 */
export function chatAccessOver(lineage: readonly ChatLineageRow[], owner: string | null) {
  const rows = new Map(lineage.map((row) => [row.id, row]));
  const access = chatAccess(async (id) => rows.get(id), owner);
  return {
    canOpen: (chatId: string) => access.canOpen(chatId),
    /** Every chat `owner` may not open. */
    async hiddenIds(): Promise<string[]> {
      const hidden: string[] = [];
      for (const id of rows.keys()) if (!(await access.canOpen(id))) hidden.push(id);
      return hidden;
    },
  };
}

/**
 * Whose chats a request may open: the signed-in person's. No actor at all is
 * in-process work, never a request from outside, and acts as the guardian.
 */
export async function callerChatOwner(): Promise<string | null> {
  const actor = await currentSessionActor();
  return actor ? sessionOwnerKey(actor) : "guardian";
}
