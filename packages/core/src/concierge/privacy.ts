// Which dashboard chats are a Concierge's, and who may open them. A leaf
// module, so the chat and action layers can ask without loading the Concierge.

import { CONCIERGE_CHAT_ID } from "@rome/api-types/concierge";
import { currentSessionActor, sessionOwnerKey } from "../lib/session-actor.js";
import { type ConciergeOwner, mainChatIdOf, ownerOf } from "./owner.js";

/** The canonical id of the core agent behind the Concierge conversation. */
export const CONCIERGE_AGENT_ID = "core:concierge";
/** `rome_sessions.trigger_kind` of a task chat Concierge started. */
export const TASK_CHAT_TRIGGER_KIND = "concierge";
/**
 * `rome_sessions.trigger_kind` of a fork of a Concierge or task chat, stamped
 * when it becomes an ordinary chat, so it stays private to that chat's owner
 * after the chat it came from is gone.
 */
export const PRIVATE_FORK_TRIGGER_KIND = "concierge_fork";

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
 * a task chat a Concierge started, and the owner stamped on a promoted fork
 * of either. Null for any other chat, which every dashboard user may open.
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
    chat.triggerKind === PRIVATE_FORK_TRIGGER_KIND
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
 * itself included, and open to everyone when the line ends with none. Every
 * path that reads, lists or searches chats asks it, so a fork, even one
 * promoted to an ordinary chat, stays as private as the chat it came from.
 *
 * A parent that no longer exists ends the line there: a fork of a private chat
 * was stamped private when it was promoted, so it needs no parent to stay so,
 * and an ordinary branch of an ordinary chat stays open. A line that cannot be
 * walked to its end (a cycle, or more than {@link MAX_FORK_DEPTH} forks) fails
 * closed: the chat is private to the owner its last readable row records.
 */
export function chatAccess(
  getRow: (id: string) => Promise<ChatLineageRow | null | undefined>,
  owner: string | null,
) {
  const settled = new Map<string, string | null>();
  const lineOwner = async (chatId: string): Promise<string | null> => {
    const known = settled.get(chatId);
    if (known !== undefined || settled.has(chatId)) return known ?? null;
    const first = await getRow(chatId);
    // A chat that does not exist is open, and its caller answers as it does today.
    if (!first) return null;
    let current: ChatLineageRow = first;
    const path: string[] = [];
    let result: string | null;
    for (;;) {
      if (settled.has(current.id)) {
        result = settled.get(current.id) ?? null;
        break;
      }
      path.push(current.id);
      const own = privateOwnerOf(current);
      if (own !== null) {
        result = own;
        break;
      }
      const parentId: string | null | undefined = current.parentSessionId;
      if (!parentId) {
        result = null;
        break;
      }
      if (path.length > MAX_FORK_DEPTH || path.includes(parentId)) {
        result = ownerOf(current);
        break;
      }
      const parent = await getRow(parentId);
      if (!parent) {
        result = null;
        break;
      }
      current = parent;
    }
    for (const id of path) settled.set(id, result);
    return result;
  };
  return {
    /** The person a chat is private to along its line of forks, or null when it is open to all. */
    privateOwner: lineOwner,
    /** Whether the owner may open the chat. One that does not exist is open, and its caller answers as it does today. */
    async canOpen(chatId: string): Promise<boolean> {
      const to = await lineOwner(chatId);
      return to === null || to === owner;
    },
  };
}

/**
 * Records on a fork's own row the owner its line of forks is private to, if
 * any, so it stays private to them after the chat it came from is gone.
 * Called when a fork becomes an ordinary chat.
 */
export async function stampForkOwner(
  repo: {
    getSession(id: string): Promise<(ChatLineageRow & { triggerName?: string | null }) | null>;
    setSessionOwnerKey(id: string, ownerKey: string): Promise<void>;
    setSessionTrigger(
      id: string,
      trigger: { triggerKind: string; triggerName: string | null },
    ): Promise<void>;
  },
  forkId: string,
): Promise<void> {
  const fork = await repo.getSession(forkId);
  if (!fork) return;
  const privateTo = await chatAccess((id) => repo.getSession(id), null).privateOwner(forkId);
  // Only a fork whose line came from a private chat is stamped; any other
  // stays as open as an ordinary chat.
  if (privateTo === null) return;
  await repo.setSessionOwnerKey(forkId, privateTo);
  await repo.setSessionTrigger(forkId, {
    triggerKind: PRIVATE_FORK_TRIGGER_KIND,
    triggerName: fork.triggerName ?? null,
  });
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
