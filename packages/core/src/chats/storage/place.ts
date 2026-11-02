// Where a message is said and where a send goes. Vocabulary:
// docs/domains/chats.md#chat and docs/domains/chats.md#place.

import type { ChatId } from "@rome-os/app-runtime";

/**
 * A chat as Chats names it: its platform and the id Chats gave it. Every
 * Chats operation takes and answers one. The adapter's own key for the chat
 * is on the {@link Chat}.
 */
export interface ChatRef {
  readonly platform: string;
  readonly id: number;
}

/**
 * What an adapter calls a chat: its platform and the adapter's key for it,
 * unique on that platform. A direct message's key names both its ends. Chats
 * keeps it beside the chat's id, compares it and never reads it.
 */
export interface ChatKey {
  readonly platform: string;
  readonly externalId: ChatId;
}

/** The key `externalId` on `platform`. */
export function chatKey(platform: string, externalId: ChatId): ChatKey {
  return { platform, externalId };
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
