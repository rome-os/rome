// The one place the channels layer turns an adapter's ids into the ids Chats
// records, and back. Contract: docs/architecture/channels.md#chat-adapters.
//
// An adapter names a chat by its key, unique on its platform, and a message
// by an id unique in its chat. This helper puts the platform in front of the
// key and the chat in front of the message id on the way into Chats, and
// strips them on the way out to the adapter. Chats reads no part of an id,
// and no adapter spells a prefix.

import type { ChatId } from "@rome-os/app-runtime";
import type { ChatRef } from "../chats/place.js";

/**
 * What a platform calls a chat, on the adapter's side of Chats: the platform
 * and the platform's own id for the chat. A direct message's id names both its
 * ends ({@link directMessageKey}). Chats never sees a key: {@link ChatIds} turns
 * it into the chat's ref, and back.
 */
export interface ChatKey {
  readonly platform: string;
  readonly externalId: ChatId;
}

export function chatKey(platform: string, externalId: ChatId): ChatKey {
  return { platform, externalId };
}

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

// The id rules each platform keeps, which only the adapter applies.

/** The other end of the direct message `key` names, or null when it names
 *  no direct message. */
export function otherEndOf(key: ChatKey): string | null {
  if (!key.externalId.startsWith(DM_PREFIX)) return null;
  const rest = key.externalId.slice(DM_PREFIX.length);
  const split = rest.indexOf(":");
  return split === -1 ? null : rest.slice(split + 1);
}

const DM_PREFIX = "dm:";

/**
 * The key of the direct message between one of Rome's accounts and another
 * account on `platform`: it names both ends, so the two of them have one
 * direct message whatever id the platform gives it, and a colleague writing
 * to two of Rome's accounts has two. Rome's end is the account's platform id,
 * or the channel's name while its record knows none.
 */
export function directMessageKey(platform: string, romeEnd: string, otherEnd: string): ChatKey {
  return chatKey(platform, `${DM_PREFIX}${romeEnd}:${otherEnd}` as ChatId);
}

/**
 * A platform message id as Chats keys it in the chat at `key`. A Telegram
 * basic group numbers messages per member account, so the same id on two of
 * Rome's accounts names two messages there, and its ids carry Rome's account
 * in front. Telegram addresses a basic group as `-<id>` below 10^12 and a
 * supergroup or channel as `-(10^12 + <id>)` (https://core.telegram.org/api/bots/ids).
 */
export function ownedBy(key: ChatKey, romeEnd: string, platformMessageId: string): string {
  if (key.platform !== "telegram" || !/^-[1-9]\d*$/.test(key.externalId)) return platformMessageId;
  return BigInt(key.externalId.slice(1)) < 1_000_000_000_000n
    ? `${romeEnd}:${platformMessageId}`
    : platformMessageId;
}

/** The platform's own id for message id `messageId` of the chat at `key`, the
 *  inverse of {@link ownedBy}. */
export function notOwnedBy(key: ChatKey, romeEnd: string, messageId: string): string {
  const owned = `${romeEnd}:`;
  return ownedBy(key, romeEnd, "") === owned && messageId.startsWith(owned)
    ? messageId.slice(owned.length)
    : messageId;
}

/**
 * The key of the direct message at `address` on `platform` between Rome's
 * end and the account `other`. Where the platform names a direct message by
 * the other party (Telegram, WhatsApp) its address is that party; email and
 * Rome Cloud chats keep their own ids.
 */
export function directMessageOn(
  platform: string,
  romeEnd: string,
  address: string,
  other: string,
): ChatKey {
  if (KEYED_BY_OWN_ID.has(platform)) return chatKey(platform, address as ChatId);
  return directMessageKey(platform, romeEnd, OTHER_END_IS_ADDRESS.has(platform) ? address : other);
}

/** Platforms whose direct message address is the other party's own id. */
const OTHER_END_IS_ADDRESS: ReadonlySet<string> = new Set(["telegram", "whatsapp"]);

/** Platforms whose chats keep their own ids, direct messages included. */
const KEYED_BY_OWN_ID: ReadonlySet<string> = new Set(["email", "agents"]);
