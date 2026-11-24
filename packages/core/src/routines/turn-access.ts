// Who may read and change routines through an agent. On the dashboard only the
// guardian reads and changes them, so an agent does only what the guardian
// asked for.

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

/** Why the turn may not change what the guardian alone changes on the
 * dashboard, or null when it may. A change is the guardian's to ask for, in
 * their own private chat: never a routine, a followed event or another agent
 * acting on what it read. `not_private` is a chat someone else can read;
 * `not_guardian` is a turn the guardian's own signed-in message did not start.
 * The same rule as a write through `core:device_run`. */
export function changeRefusalReason(turn: RoutineTurn): "not_private" | "not_guardian" | null {
  if (turn.audience !== "private") return "not_private";
  const actor = turn.actor;
  if (actor?.kind !== "guardian" || actor.via !== "cookie") return "not_guardian";
  return null;
}

/** Why the turn may not change a routine, or null when it may, by
 * {@link changeRefusalReason}. */
export function changeRefusal(turn: RoutineTurn): string | null {
  switch (changeRefusalReason(turn)) {
    case "not_private":
      return "routine_private_only: This chat is not private with the guardian, so routines cannot be changed from it. Say so, and that they can ask in their own chat.";
    case "not_guardian":
      return "routine_needs_guardian: Only the guardian's own message can change a routine, and this turn did not start from one. Change nothing; tell them what you would change, so they can ask for it themselves.";
    case null:
      return null;
  }
}
