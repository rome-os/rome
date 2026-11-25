import type {
  ChatId,
  ChatRef,
  ChatSessionScope,
  ProviderSessionResetPolicy,
} from "@rome-os/app-runtime";
import { type ChatSession, sessionOfChat } from "../participation/session-scope.js";
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

/** The session scope Chat settings holds for a connected account's chat. */
export type ChatSessionScopeOf = (chat: ChatRef) => Promise<ChatSessionScope | null>;

/**
 * The session an opener opens by continuity key for a message: the one its
 * chat's session scope names (participation/session-scope.ts), when the
 * opener asked for the chat's own session. Any other key, such as a
 * sentinel's, a turn that answers no message, or one not on a connected
 * account, opens as asked.
 */
export async function sessionOfMessage(
  scopeOf: ChatSessionScopeOf | undefined,
  run: MessageTurn,
  requestedKey: string,
): Promise<ChatSession> {
  const thread = run.threadContext;
  if (!scopeOf || !run.platformMessageId || !thread?.connectionId) {
    return { continuityKey: requestedKey };
  }
  const chat = { channel: thread.channel, chatId: thread.threadId };
  if (requestedKey !== sessionOfChat(chat, "chat").continuityKey) {
    return { continuityKey: requestedKey };
  }
  const scope = await scopeOf({
    connectionId: thread.connectionId,
    chatId: thread.threadId as ChatId,
  });
  return sessionOfChat(chat, scope ?? "chat");
}
