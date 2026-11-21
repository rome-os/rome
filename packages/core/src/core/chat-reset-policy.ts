import type { ChatId, ChatRef, ProviderSessionResetPolicy } from "@rome-os/app-runtime";
import type { ThreadContext } from "./types.js";

/** The reset policy Chat settings holds for a connected account's chat. */
export type ChatResetPolicy = (chat: ChatRef) => Promise<ProviderSessionResetPolicy | null>;

/** A turn as its opener receives it, before it opens a session by continuity key. */
interface MessageTurn {
  /** Set when the turn answers a message that arrived in a chat. */
  platformMessageId?: string;
  threadContext?: ThreadContext;
}

/**
 * The reset policy an opener hands the session it opens by continuity key for
 * a message: the policy of the connected account's chat the message arrived
 * in. None when no chat sets one, the turn answers no message, or the message
 * did not arrive through a connected account. A session resumed by id takes
 * none, so an opener asks only when it opens by continuity key.
 */
export async function resetPolicyOfMessage(
  policyOf: ChatResetPolicy | undefined,
  run: MessageTurn,
): Promise<ProviderSessionResetPolicy | undefined> {
  const thread = run.threadContext;
  if (!policyOf || !run.platformMessageId || !thread?.connectionId) {
    return undefined;
  }
  const chat = { connectionId: thread.connectionId, chatId: thread.threadId as ChatId };
  return (await policyOf(chat)) ?? undefined;
}
