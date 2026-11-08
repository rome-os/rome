/** A message said where a session stands, as the agent reads it. */
export interface PromptMessage {
  readonly id: number;
  readonly senderName: string | null;
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
   *  took, gave or saw, oldest first. Null where the session catches up on
   *  nothing, because every message said there already reaches the agent. */
  unseen(sessionId: string): UnseenMessage[] | null;
  /** Turn `turnId` of session `sessionId` was shown `messageIds`. */
  seen(messageIds: readonly number[], sessionId: string, turnId: string): void;
}
