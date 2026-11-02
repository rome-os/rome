// Where a message is said and where a send goes. Vocabulary:
// docs/domains/chats.md#chat and docs/domains/chats.md#place.

import type { ChatId } from "@rome-os/app-runtime";

/**
 * A chat's identity: the platform and the platform's own id for the chat. Two
 * keys name one chat when both fields are equal. Whether the chat is a group
 * or a direct message is not part of it.
 *
 * Over today's storage the id is the address a channel hands out for the chat,
 * so a group two of Rome's accounts are in can still carry two ids until the
 * storage moves.
 */
export interface ChatKey {
  readonly platform: string;
  readonly id: ChatId;
}

/** A chat, or a thread in one. `threadId` is the platform's own id for the
 *  thread, which a channel hands out as an address of its own. */
export interface Place {
  readonly chat: ChatKey;
  readonly threadId?: ChatId;
}

export function chatKey(platform: string, id: ChatId): ChatKey {
  return { platform, id };
}

/** The chat itself, or the thread `threadId` names in it. */
export function placeIn(chat: ChatKey, threadId?: ChatId): Place {
  return threadId === undefined ? { chat } : { chat, threadId };
}

/** The address a channel sends to for this place: the thread's when it names
 *  one, else the chat's. */
export function addressOf(place: Place): ChatId {
  return place.threadId ?? place.chat.id;
}
