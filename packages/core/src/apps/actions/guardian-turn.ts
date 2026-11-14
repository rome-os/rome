import { actionExecutionContext } from "./context.js";

/**
 * Whether the action running now was asked for by the guardian: the session
 * actor is the guardian, or, for a turn with no actor such as an autonomous
 * Concierge turn, the chat it runs in is the guardian's. A dashboard chat must
 * be the guardian's either way. Call it inside an action's `execute` or
 * `preview`. `ownerOfChat` answers "guardian" or "visitor:<account>", or null
 * for a chat that no longer exists.
 */
export async function askedByGuardian(
  ownerOfChat: (chatId: string) => Promise<string | null>,
): Promise<boolean> {
  const context = actionExecutionContext.getStore();
  const actor = context?.actor;
  if (actor && actor.kind !== "guardian") return false;
  const thread = context?.channelContext;
  const owner =
    thread?.channel === "webchat" && thread.threadId ? await ownerOfChat(thread.threadId) : null;
  if (thread?.channel === "webchat" && owner !== "guardian") return false;
  return Boolean(actor) || owner === "guardian";
}
