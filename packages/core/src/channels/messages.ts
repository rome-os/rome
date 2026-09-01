/**
 * What was said to a channel's accounts, as one store holds it. `Accounts` (accounts.ts) answers who a channel can reach, and this
 * answers what passed between Rome and them.
 *
 * A message is a {@link TimelineEntry}, however the store was asked for it. A
 * store holds one history and ranks it one way, and every read below cuts that
 * one ranking. The shape, the ordering and the cursor are written down in the
 * People contract (`@rome/api-types/people`) because a person's timeline was
 * the first surface to page them, not because it is the only one: a second
 * shape here would be a second ranking of the same rows, which is a page
 * boundary the two ends disagree about.
 */

import type { TimelineEntry } from "@rome/api-types/people";

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

/**
 * One conversation a store reads for: the thread a message was said in, named
 * by the platform's own id for it, on the channel that holds it.
 *
 * The pair rather than the id alone, for the reason an account carries its
 * channel — two channels are free to spell an id the same way and mean two
 * different threads.
 *
 * A direct conversation is addressed by the person on it, so on a channel that
 * keys a thread by who is on it the id is also an address of their account. A
 * group conversation is addressed by the group and by nobody on it, so no
 * account names it and only this names it.
 */
export interface MessageConversation {
  channel: string;
  id: string;
}

export interface MessageRead {
  accounts: readonly MessageAccount[];
  /** The entry the previous page ended on. Null or absent for the first page. */
  after?: TimelineEntry | null;
  limit: number;
}

export interface ConversationRead {
  conversation: MessageConversation;
  /** The entry the previous page ended on. Null or absent for the first page. */
  after?: TimelineEntry | null;
  limit: number;
}

/**
 * One message store, asked for a set of accounts or for a conversation.
 *
 * A set of accounts is read as one history: a person holds several accounts and
 * an account several addresses, and the caller wants the messages merged, not
 * one sequence per address.
 *
 * One law binds the three account-scoped verbs. Call the *full read* of a set
 * of accounts the `read` with no cursor and a limit large enough to hold
 * everything the store can answer for them:
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
 * `read`, `count` and `latest` answer direct threads only. A group
 * conversation is addressed by the group rather than by any person on it, so no
 * address of an account names it and none of its messages reaches those three.
 * `readConversation` is what reaches it.
 */
export interface Messages {
  /**
   * The store's newest messages for `accounts`, at most `limit` of them, every
   * one strictly after `after`, in `compareTimelineEntries` order — newest
   * first, and total.
   *
   * "Strictly after `after`" is the store's own obligation and not the
   * caller's: a store that answered its newest `limit` messages and left the
   * filtering above it would spend that budget on messages the caller has
   * already seen, and the ones it dropped to make room are the ones no page
   * ever shows.
   */
  read(request: MessageRead): Promise<TimelineEntry[]>;

  /** How many messages the full read of `accounts` answers. */
  count(accounts: readonly MessageAccount[]): Promise<number>;

  /**
   * The first entry of the full read of `accounts`, or null when the store
   * holds none.
   *
   * `read` with a limit of one, declared as its own verb so a store can answer
   * it in one pass over a whole directory rather than one page per row.
   */
  latest(accounts: readonly MessageAccount[]): Promise<TimelineEntry | null>;

  /**
   * The store's newest messages in `conversation`, on `read`'s terms exactly:
   * at most `limit`, every one strictly after `after`, newest first and total.
   *
   * Every message of the conversation, including the ones the account-scoped
   * verbs answer none of. A group's messages are the case that makes the verb
   * worth having, and a direct conversation is answered here too — one store
   * asked a second way, not a second store.
   *
   * Every store owes this verb, and none declines it. A store answering the
   * account reads holds the rows a conversation read wants — it is the same
   * history keyed the other way — so there is no way to say "not this one"
   * here. A store that genuinely could not answer would be a second interface,
   * and splitting one is a change to make when there is a store to make it for.
   *
   * An empty page is the whole answer for a conversation the store holds no
   * messages of. A conversation the store has never heard of and one it holds
   * empty are answered the same way: no caller has the question that tells
   * them apart, and a store that failed the first would refuse a conversation
   * that exists on the channel and has simply not been mirrored yet.
   */
  readConversation(request: ConversationRead): Promise<TimelineEntry[]>;
}
