import type { ChatId, ChatRef, ProviderSessionResetPolicy } from "@rome-os/app-runtime";
import type { ThreadContext } from "./types.js";

/** The reset policy Chat settings holds for a connected account's chat. */
export type ChatResetPolicy = (chat: ChatRef) => Promise<ProviderSessionResetPolicy | null>;

/** A run as its opener receives it, before it opens a session. */
interface MessageRun {
  /** Set when the run answers a message that arrived in a chat. */
  platformMessageId?: string;
  /** Set when the run names its session by id. */
  sessionId?: string;
  threadContext?: ThreadContext;
}

/**
 * The reset policy an opener hands the session it opens for a message: the
 * policy of the connected account's chat the message arrived in. None when no
 * chat sets one, the run answers no message, the message did not arrive
 * through a connected account, or the run names its session by id, since a
 * session named by id is resumed as it is.
 */
export async function resetPolicyOfMessage(
  policyOf: ChatResetPolicy | undefined,
  run: MessageRun,
): Promise<ProviderSessionResetPolicy | undefined> {
  const thread = run.threadContext;
  if (!policyOf || !run.platformMessageId || run.sessionId || !thread?.connectionId) {
    return undefined;
  }
  const chat = { connectionId: thread.connectionId, chatId: thread.threadId as ChatId };
  return (await policyOf(chat)) ?? undefined;
}
