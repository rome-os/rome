import type { ThreadContext } from "@rome-os/app-runtime";

/** A message said where a session stands, as the agent reads it. */
export interface PromptMessage {
  readonly id: number;
  /** What the message called its sender, as the platform showed it. The
   *  sender chose it, so it proves nothing. Null when it showed none. */
  readonly sender: string | null;
  /** Who the sender is, as Rome knows them, worded by the port's
   *  implementation for the agent to read as is. Kept apart from `sender`, so
   *  no name a sender picks can pass for it. Null when Rome has no answer. */
  readonly who: string | null;
  readonly text: string;
  readonly at: Date;
}

/** A message the session has not seen, with the message it quotes. */
export interface UnseenMessage extends PromptMessage {
  readonly fromRome: boolean;
  readonly quoted: PromptMessage | null;
  /** Whether the quoted message was said outside the session's thread, in the
   *  open chat, as the message that started the thread is. */
  readonly quotesOutside: boolean;
}

/**
 * Port. What a turn's prompt needs to know about where its session stands:
 * the messages said there that the session has not seen, and which of them
 * a turn was shown.
 */
export interface PromptFacts {
  /** The messages said where session `sessionId` stands that no turn of it
   *  took, gave or saw, oldest first. Empty when it has seen them all: the
   *  turn's prompt still carries the message it quotes and who said the
   *  message it answers. Null where every message said there already reaches
   *  the agent: the prompt carries no catch-up, no quoted message and no
   *  sender. */
  unseen(sessionId: string): Promise<UnseenMessage[] | null>;
  /** The messages `messageIds` names that Rome holds, as the agent reads them
   *  now, in no particular order. */
  read(messageIds: readonly number[]): Promise<PromptMessage[]>;
  /** Turn `turnId` of session `sessionId` was shown `messageIds`. */
  seen(messageIds: readonly number[], sessionId: string, turnId: string): void;
  /**
   * The latest messages said in `place` before `before`, oldest first, read
   * from where the chat itself lives rather than from Rome's record, so a
   * new session sees them whether or not Rome holds a copy. Each names who
   * said it as {@link PromptMessage} does. Null where none can be read: a
   * place whose channel hands the agent every message, a platform with no
   * read, or a read that failed or ran out of time. Absent, nothing is read.
   * `first`, when given, is the id of the message the session opens on: it,
   * and what was said after it within `before`'s second, are left out by the
   * platform's own order, since Rome's record keeps whole seconds.
   */
  earlier?(place: ThreadContext, before: Date, first?: number): Promise<UnseenMessage[] | null>;
  /**
   * The earlier messages of platform thread `thread`, said in `place`'s
   * conversation, read as {@link earlier} reads a chat: before `before` and
   * below message `first`, oldest first. `since`, when given, is the id of
   * the last message of the thread the model was shown: it, and what was said
   * before it, are left out. Null where none can be read. Absent, a thread's
   * earlier messages are not read.
   */
  thread?(
    place: ThreadContext,
    thread: string,
    before: Date,
    first?: number,
    since?: number,
  ): Promise<UnseenMessage[] | null>;
}
