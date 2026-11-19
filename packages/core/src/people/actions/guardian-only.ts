// Whether an action runs for the guardian. People's actions read and change
// what the guardian keeps on people, so a visitor's turn never reaches them.

import { actionExecutionContext } from "../../apps/actions/context.js";

/** Whose chat it is ("guardian" or "visitor:<account>"), or null for a chat that no longer exists. */
export type OwnerOfChat = (chatId: string) => Promise<string | null>;

/**
 * Whether the running action is the guardian's: not a visitor as the turn's
 * actor, and not a turn no one started in a chat a visitor owns, such as a task
 * the Concierge runs for them. A turn with neither an actor nor a chat, such as
 * an agent summoned from that task, cannot show it is the guardian's and is
 * refused too. A chat on a connection has no owner and is the guardian's
 * agent's.
 */
export async function runsForGuardian(ownerOfChat: OwnerOfChat): Promise<boolean> {
  const context = actionExecutionContext.getStore();
  if (context?.actor && context.actor.kind !== "guardian") return false;
  const thread = context?.channelContext;
  if (!context?.actor && !thread) return false;
  if (thread?.channel === "webchat") {
    const owner = thread.threadId ? await ownerOfChat(thread.threadId) : null;
    if (owner !== "guardian") return false;
  }
  return true;
}
