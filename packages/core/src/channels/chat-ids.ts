// The one place the channels layer turns an adapter's ids into the ids Chats
// records, and back. Contract: docs/architecture/channels.md#chat-adapters.
//
// An adapter names a chat by its key, unique on its platform, and a message
// by an id unique in its chat. This helper puts the platform in front of the
// key and the chat in front of the message id on the way into Chats, and
// strips them on the way out to the adapter. Chats reads no part of an id,
// and no adapter spells a prefix.

import type { ChatId } from "@rome-os/app-runtime";
import { chatKey, type ChatKey, type ChatRef } from "../chats/place.js";

/** The dashboard's platform, whose adapter gives its chats and lines random
 *  ids, with no platform key behind them. */
const DASHBOARD = "webchat";

export const ChatIds = {
  /**
   * The chat at `key`, by the id Chats records it under: `<platform>:<key>`,
   * so ids never meet across platforms. On the dashboard the key is the
   * chat's own id.
   */
  chat(key: ChatKey): ChatRef {
    return {
      platform: key.platform,
      id: key.platform === DASHBOARD ? key.externalId : `${key.platform}:${key.externalId}`,
    };
  },

  /** The adapter's key for chat `ref`, the inverse of {@link ChatIds.chat}. */
  key(ref: ChatRef): ChatKey {
    const prefix = `${ref.platform}:`;
    return chatKey(
      ref.platform,
      (ref.platform !== DASHBOARD && ref.id.startsWith(prefix)
        ? ref.id.slice(prefix.length)
        : ref.id) as ChatId,
    );
  },

  /**
   * The id Chats records the message the adapter calls `messageId` under in
   * chat `chat`: `<chat id>/<message id>`. A redelivery, or the same group
   * message heard on another of Rome's accounts, finds it on record. A
   * dashboard line's id is its own.
   */
  message(chat: ChatRef, messageId: string): string {
    return chat.platform === DASHBOARD ? messageId : `${chat.id}/${messageId}`;
  },

  /** The adapter's id for line `messageId` of chat `chatId`, the inverse of
   *  {@link ChatIds.message}, or null for a line it gave no id of its own. */
  platformMessage(chatId: string, messageId: string): string | null {
    const prefix = `${chatId}/`;
    return messageId.startsWith(prefix) ? messageId.slice(prefix.length) : null;
  },
} as const;
