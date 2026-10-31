// Where a message is said and where a send goes. Vocabulary:
// docs/domains/chats.md#chat and docs/domains/chats.md#place.

import type { ChatId } from "@rome-os/app-runtime";

/**
 * A chat's identity: the platform and the platform's own id for the chat. Two
 * keys name one chat when both fields are equal. Whether the chat is a group
 * or a direct message is not part of it. A direct message's id names both its
 * ends ({@link directMessageKey}). A dashboard chat's id is one the dashboard
 * gave it when it opened. Chats reads no meaning into either.
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

/**
 * The address a channel sends to for this place: the thread's when it names
 * one, the other end of a direct message, else the chat's own id.
 */
export function addressOf(place: Place): ChatId {
  if (place.threadId !== undefined) return place.threadId;
  return (otherEndOf(place.chat) ?? place.chat.id) as ChatId;
}

/** The other end of the direct message `key` names, or null when it names
 *  no direct message. */
export function otherEndOf(key: ChatKey): string | null {
  if (!key.id.startsWith(DM_PREFIX)) return null;
  const rest = key.id.slice(DM_PREFIX.length);
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
  if (key.platform !== "telegram" || !/^-[1-9]\d*$/.test(key.id)) return platformMessageId;
  return BigInt(key.id.slice(1)) < 1_000_000_000_000n
    ? `${romeEnd}:${platformMessageId}`
    : platformMessageId;
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
