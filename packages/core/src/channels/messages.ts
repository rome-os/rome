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

import type { Message } from "@rome/api-types/message";
import type { ChannelMessage, ConversationId } from "@rome-os/app-runtime";

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
}

export interface MessageRead {
  accounts: readonly MessageAccount[];
  /** The entry the previous page ended on. Null or absent for the first page. */
  after?: Message | null;
  limit: number;
}

/**
 * What `query` asks for. Every field narrows it, and none is required: a query
 * naming nothing asks for the channel's newest messages.
 */
export interface MessageQuery {
  /** One conversation, by the platform's own id for it. Absent for every
   *  conversation the channel can read. */
  conversationId?: ConversationId;
  /** Only messages said at or after this instant. */
  since?: Date;
  /** At most this many. Defaults to {@link DEFAULT_QUERY_LIMIT} and is capped
   *  at {@link MAX_QUERY_LIMIT}. */
  limit?: number;
}

const DEFAULT_QUERY_LIMIT = 100;
const MAX_QUERY_LIMIT = 1_000;

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
      id: message.conversationId,
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
