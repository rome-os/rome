// Where a message is said and where a send goes. Vocabulary:
// docs/domains/chats.md#chat and docs/domains/chats.md#place.

import type { ChatId } from "@rome-os/app-runtime";

/**
 * A chat as Chats names it: its platform and its id, which is its adapter's
 * and opaque to Chats. Every Chats operation takes and answers one.
 */
export interface ChatRef {
  readonly platform: string;
  readonly id: string;
}

/** A chat, or a thread in one. `threadId` is the platform's own id for the
 *  thread, which a channel hands out as an address of its own. */
export interface Place {
  readonly chat: ChatRef;
  readonly threadId?: ChatId;
}

/** The chat itself, or the thread `threadId` names in it. */
export function placeIn(chat: ChatRef, threadId?: ChatId): Place {
  return threadId === undefined ? { chat } : { chat, threadId };
}
