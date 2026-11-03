/**
 * What was said on a channel, however the channel holds it. `Accounts`
 * (accounts.ts) answers who a channel can reach, and this answers what passed
 * between Rome and them.
 *
 * Two shapes answer, one per question:
 *
 * - `query` answers a {@link ChannelMessage}, the one record every port speaks:
 *   the one `inbound` delivers, with the channel and the direction added.
 * - The account reads answer a {@link Message}, the People timeline's record,
 *   because that timeline merges several stores and pages them with one cursor.
 *   Its ordering and cursor are the message module's (`@rome/api-types/message`),
 *   stated once there so a store and a person's timeline cut the same ranking.
 */

import { compareMessages, messageCursor, type Message } from "@rome/api-types/message";
import type { ChannelMessage, ChannelMessageQuery } from "@rome-os/app-runtime";

/**
 * One account a store reads for, named by every address it answers to —
 * `Account.addresses` on the channel's own address book.
 *
 * The addresses rather than the id, because a store keys its rows by whichever
 * address a message arrived on: a WhatsApp contact is reachable under both a
 * phone JID and a `@lid` JID, and history hangs off either. A read that named
 * only the address a person mapping happens to carry would answer an empty
 * history for a conversation that plainly exists.
 *
 * What `timelineAccounts` (../people/timeline-sources.ts) folds a person's
 * links into, and what every store a person's history is read from is then
 * scoped by.
 */
export interface MessageAccount {
  channel: string;
  /** Non-empty. Order carries no meaning. */
  addresses: readonly string[];
  /**
   * The channels the account's messages are stored under, when they are not
   * `channel` alone: a link names the account's platform, and a store keys a
   * message by the channel it arrived on, so an account on a platform Rome
   * holds several accounts on is read under each of their channels. Empty,
   * a store reads nothing for the account. Absent, `channel`. Either way an
   * entry read for the account carries `channel` as its `source`, so a reader
   * matches it against the account it asked about.
   */
  storedUnder?: readonly string[];
}

/** The channels a store reads `account` under. */
export function heldOn(account: MessageAccount): readonly string[] {
  return account.storedUnder ?? [account.channel];
}

export interface MessageRead {
  accounts: readonly MessageAccount[];
  /** The entry the previous page ended on. Null or absent for the first page. */
  after?: Message | null;
  limit: number;
}

/** What `query` asks for: the SDK's {@link ChannelMessageQuery}, so the
 *  defaults and the cap are stated once. `queryLimit` applies them. */
export type MessageQuery = Omit<ChannelMessageQuery, "after"> & {
  /** The message the previous page ended on, as {@link channelMessageOrder}
   *  names it. Only the messages after it, the older ones, answer. */
  after?: Message;
};

const DEFAULT_QUERY_LIMIT = 100;
export const MAX_QUERY_LIMIT = 1_000;

/** What a People timeline entry says about a message beyond the line itself. */
export type MessageDetail = Pick<Message, "sender" | "conversation" | "attachments">;

/**
 * The detail a {@link ChannelMessage} carries, as a timeline entry carries it.
 * A store answering both reads maps a row to a `ChannelMessage` once and takes
 * the entry's detail from it, so the two reads describe one row the same way.
 */
export function channelMessageDetail(message: ChannelMessage): MessageDetail {
  const detail: MessageDetail = {
    sender: { id: message.senderId || null, name: message.senderDisplayName || null },
    conversation: {
      id: message.chatId,
      name: message.thread?.name ?? null,
      kind: message.thread?.kind ?? null,
    },
  };
  if (message.attachments.length > 0) {
    detail.attachments = message.attachments.map((attachment) => ({
      type: attachment.type,
      ...(attachment.mimeType ? { mimeType: attachment.mimeType } : {}),
      ...(attachment.fileName ? { fileName: attachment.fileName } : {}),
      ...(attachment.caption ? { caption: attachment.caption } : {}),
    }));
  }
  return detail;
}

/**
 * The earliest instant a query reads from, rounded up to a whole second: every
 * store here keeps seconds, so a `since` inside a second answers only the
 * seconds after it rather than the one it falls in.
 */
export function querySince(since: Date | undefined): Date {
  if (!since) return new Date(0);
  return new Date(Math.ceil(since.getTime() / 1000) * 1000);
}

/**
 * A channel message as the message module names one: when it was said, which
 * way, and a ref that names the chat as well as the message, since a
 * platform's message ids are unique only within one chat.
 */
export function channelMessageOrder(message: ChannelMessage): Message {
  return {
    source: message.channel,
    timestamp: Math.floor(message.timestamp.getTime() / 1000),
    direction: message.direction,
    ref: `${message.chatId}:${message.messageId}`,
    body: null,
  };
}

/** The opaque cursor a query answers on each message: resuming from it with
 *  `after` reads the messages older than it. */
export function channelMessageCursor(message: ChannelMessage): string {
  return messageCursor(channelMessageOrder(message));
}

/**
 * One page of a query from what a store read, newest first in the store's own
 * order: the messages after `after`, at most `limit` of them. The cursor names
 * one message, so the page resumes right behind it, also among several said
 * in one second. Filtering comes before the limit, so the page is never spent
 * on messages the caller has already read.
 *
 * A store hands over at least the cursor's whole second and what is older. A
 * cursor whose message is gone resumes at the second before its own.
 */
export function queryPage(
  messages: readonly ChannelMessage[],
  read: Pick<MessageQuery, "after" | "limit">,
): ChannelMessage[] {
  const { after } = read;
  let older: readonly ChannelMessage[] = messages;
  if (after) {
    const at = messages.findIndex(
      (message) => compareMessages(channelMessageOrder(message), after) === 0,
    );
    older =
      at >= 0
        ? messages.slice(at + 1)
        : messages.filter((message) => channelMessageOrder(message).timestamp < after.timestamp);
  }
  return older.slice(0, queryLimit(read.limit));
}

/**
 * What a store keeping a copy reads for one page after a cursor, newest first:
 * every message of the cursor's second, so the page settles the ties there,
 * and the newest `limit` older ones. Without a cursor, the newest `limit`.
 * `read` answers oldest first, at most `limit` messages at or after `since`
 * and at or before `until`.
 */
export async function readQueryWindow<T>(
  read: (since: Date, limit: number, until?: Date) => Promise<T[]>,
  query: Pick<MessageQuery, "since" | "after" | "limit">,
): Promise<T[]> {
  const from = querySince(query.since);
  const after = query.after;
  if (!after) return (await read(from, queryLimit(query.limit))).reverse();
  const second = new Date(after.timestamp * 1000);
  const ties = await read(
    new Date(Math.max(from.getTime(), second.getTime())),
    MAX_QUERY_LIMIT,
    second,
  );
  const older = await read(from, queryLimit(query.limit), new Date(second.getTime() - 1000));
  return [...ties.reverse(), ...older.reverse()];
}

/** The number of messages a query asks for, defaulted and capped. */
export function queryLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) return DEFAULT_QUERY_LIMIT;
  return Math.max(1, Math.min(Math.floor(limit), MAX_QUERY_LIMIT));
}

/**
 * What was said on one channel.
 *
 * `query` is the one read every channel answers, whoever holds the data. A
 * channel reading a copy Rome keeps and one asking the platform live answer
 * the same record in the same order, and no caller can tell them apart. What
 * does differ is left to the port rather than the caller: a live read costs a
 * platform call and fails while nothing backs the channel, and neither kind is
 * complete — a copy holds what was synced, and a live read what the platform
 * hands back within its own limits.
 */
export interface Messages {
  /**
   * The channel's newest messages that match, newest first: every direction,
   * every conversation unless one is named, groups included.
   *
   * A conversation the channel holds nothing of answers an empty list, the same
   * answer as one it has never heard of.
   */
  query(request: MessageQuery): Promise<ChannelMessage[]>;

  /**
   * The reads a People timeline makes per person, where the channel keeps a
   * copy that can answer them at a directory's scale. Null where it does not.
   */
  readonly byAccount: AccountMessages | null;
}

/**
 * One store asked for a set of accounts: what a People timeline reads.
 *
 * A set of accounts is read as one history: a person holds several accounts and
 * an account several addresses, and the caller wants the messages merged, not
 * one sequence per address.
 *
 * One law binds the three verbs. Call the *full read* of a set of accounts the
 * `read` with no cursor and a limit large enough to hold everything the store
 * can answer for them:
 *
 * - `count` is the length of the full read.
 * - `latest` is its first entry, and null when the full read is empty.
 *
 * So a row previewing `latest` previews exactly the entry the page beneath it
 * opens on, and the count beside it measures exactly the history that page
 * walks. A store answering the three on their own terms could preview an entry
 * its own pages never show.
 *
 * `latest` answering null is how a caller learns the store holds nothing for
 * an account. There is no `holds` verb — a second way to ask the same question
 * is a second answer to disagree with.
 *
 * The three answer direct threads only. A group conversation is addressed by
 * the group rather than by any person on it, so no address of an account names
 * it and none of its messages reaches these reads. `Messages.query` reaches it.
 *
 * Not every store is a channel's: Rome's own transcript and the sentinel's log
 * answer these reads for every channel at once.
 */
export interface AccountMessages {
  /**
   * The store's newest messages for `accounts`, at most `limit` of them, every
   * one strictly after `after`, in `compareMessages` order — newest
   * first, and total.
   *
   * "Strictly after `after`" is the store's own obligation and not the
   * caller's: a store that answered its newest `limit` messages and left the
   * filtering above it would spend that budget on messages the caller has
   * already seen, and the ones it dropped to make room are the ones no page
   * ever shows.
   */
  read(request: MessageRead): Promise<Message[]>;

  /** How many messages the full read of `accounts` answers. */
  count(accounts: readonly MessageAccount[]): Promise<number>;

  /**
   * The first entry of the full read of `accounts`, or null when the store
   * holds none.
   *
   * `read` with a limit of one, declared as its own verb so a store can answer
   * it in one pass over a whole directory rather than one page per row.
   */
  latest(accounts: readonly MessageAccount[]): Promise<Message | null>;
}
