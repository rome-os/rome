// Who may read routines through an agent. On the dashboard only the guardian
// reads them, so an agent reads them only for the guardian.

import type { RoutineTurn } from "./control.js";

/** Whose chat it is ("guardian" or "visitor:<account>"), or null for a chat
 * that no longer exists. */
export type OwnerOfChat = (chatId: string) => Promise<string | null>;

/** Whether the turn works for the guardian, who alone reads routines on the
 * dashboard. A visitor's turn, or a turn no one started in a visitor's chat, is
 * refused. A turn with neither an actor nor a chat cannot show it is the
 * guardian's and is refused too. A chat on a connection has no owner and is
 * the guardian's agent's. The same rule as `core:read_person`. */
export async function turnWorksForGuardian(
  ownerOfChat: OwnerOfChat,
  turn: RoutineTurn,
): Promise<boolean> {
  if (turn.actor && turn.actor.kind !== "guardian") return false;
  const thread = turn.channelContext;
  if (!turn.actor && !thread) return false;
  if (thread?.channel === "webchat") {
    const owner = thread.threadId ? await ownerOfChat(thread.threadId) : null;
    if (owner !== "guardian") return false;
  }
  return true;
}
