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
}
