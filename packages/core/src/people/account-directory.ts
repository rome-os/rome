// Every account Rome has observed, in the shape the account contract puts on
// the wire (@rome/api-types/people). Three sources, folded into one list: the
// links the guardian has made, the sentinel log's senders, and the address
// books Rome mirrors.
//
// An account is one person on one channel, whatever addresses that channel
// reaches them at. Which of them fold together is the channel's own answer,
// read once through `AccountFold` (../channels/account-fold.ts), so nothing
// here is channel-specific and adding a mirror changes nothing in this file.
//
// Two reads, because the two surfaces ask two questions — "who does Rome know"
// and "who has something new". They fold the same address books to decide which
// addresses are one account, and only the stream goes on to read a history.

import {
  accountPresentation,
  compareCodePoints,
  latestDynamic,
  type DirectoryAccount,
  type StreamAccount,
  type TimelineEntry,
} from "@rome/api-types/people";
import { STRANGER_PERSON_ID } from "../constants.js";
import type { AccountNames } from "../channels/account-names.js";
import { foldAccounts } from "../channels/account-fold.js";
import { addressBooks, type Channels } from "../channels/channel.js";
import type { DrizzleDb } from "../db/index.js";
import type { PersonMappingRepository } from "../db/repositories/person-mapping.js";
import type { SentinelLogRepository } from "../db/repositories/sentinel-log.js";
import { assignAccountHeads } from "./timeline.js";
import { personMessageStores } from "./timeline-sources.js";

export interface AccountDirectoryDeps {
  /** Every channel Rome mirrors — the address books this folds, and the stores
   *  the stream reads a history from. */
  channels: Channels;
  personMappingRepo: Pick<PersonMappingRepository, "findAllWithMappings">;
  sentinelLogRepo: Pick<SentinelLogRepository, "listSenders">;
  accountNames: Pick<AccountNames, "displayNames">;
  /** Where the message stores live. Read by the stream alone — the contacts
   *  list never reaches a history. */
  db: DrizzleDb;
}

/** The link an account carries, before {@link accountPresentation} decides how
 *  it renders. */
interface AccountLink {
  personId: string;
  displayName: string;
}

/**
 * Every account there is, unordered and unfiltered — the whole directory a page
 * is cut out of (`sliceAccountDirectory`).
 *
 * Whole rather than paged: the fold that decides which addresses are one
 * account needs every address book entire, and an account past a channel's own
 * cutoff is one the guardian cannot find and no count includes. The cost is one
 * read of each address book for the fold and one more to name what it found.
 *
 * A contacts list's rows: who each account is, and nothing about what anyone
 * said. No message store is read — not a mirror's history and not the triage
 * record's — because the directory orders by name and previews nothing, so
 * every message-derived fact would be work no reader of this read ever renders.
 * {@link readAccountStream} is the read that does.
 */
export async function readAccountDirectory(
  deps: AccountDirectoryDeps,
): Promise<DirectoryAccount[]> {
  return observeAccounts(deps);
}

/**
 * Every account something has happened on, unordered and unfiltered — the whole
 * stream a page is cut out of (`sliceAccountStream`).
 *
 * The same accounts as {@link readAccountDirectory} over the same sources,
 * projected the other way: with the dynamic the stream orders and previews by,
 * and without the accounts that have none. An address-book contact nobody has
 * ever heard from has no position in an order made of timestamps, so it is
 * absent rather than listed last.
 *
 * The dynamic is the entry that claims the account, through the same
 * `assignAccountHeads` the person's own page and the people listing settle
 * ownership with, over the same `personMessageStores` precedence. So a row
 * previews exactly what the page beneath it opens on, and being on the stream
 * at all means some store answered a `latest`: silence is that answering
 * nothing rather than a flag any producer sets.
 *
 * Read in rounds rather than all at once — see {@link ADDRESSES_PER_ROUND}.
 */
export async function readAccountStream(deps: AccountDirectoryDeps): Promise<StreamAccount[]> {
  const accounts = await observeAccounts(deps);
  const stores = personMessageStores(deps);

  const heads = new Map<DirectoryAccount, TimelineEntry>();
  for (const round of rounds(accounts)) {
    for (const [account, owned] of await assignAccountHeads(stores, round)) {
      heads.set(account, owned.head);
    }
  }

  return accounts.flatMap((account) => {
    const head = heads.get(account);
    const dynamic = latestDynamic(head ? [head] : []);
    return dynamic === null ? [] : [{ ...account, latest: dynamic }];
  });
}

/**
 * How many addresses one round of ownership reads covers.
 *
 * A SQL store answers a whole round in one statement, binding a bounded handful
 * of variables per address in it, and SQLite refuses any statement carrying
 * more than 32,766 of them. This is the one read that asks about a whole
 * address book at once, and an address book is thousands of contacts — so
 * asking about all of them in a single round is a stream that fails outright on
 * an ordinary WhatsApp directory rather than one that pages it.
 *
 * A thousand addresses leaves that ceiling more than an order of magnitude of
 * headroom while keeping the rounds few, and so the passes over each store few:
 * the grouping that makes a directory cost one pass instead of one per row
 * still holds, just per round rather than once.
 *
 * Bounded here rather than inside the stores: the ceiling is a property of the
 * statement a store builds, but only a caller knows it is about to ask about
 * every account there is, and a store cannot chunk work it is handed a call at
 * a time.
 */
const ADDRESSES_PER_ROUND = 1000;

/**
 * The accounts split into rounds no wider than {@link ADDRESSES_PER_ROUND}.
 *
 * By addresses rather than by accounts because that is what the stores are
 * scoped by: an account reachable three ways costs three times what one
 * reachable a single way does. An account wider than a whole round still gets
 * one of its own rather than being dropped.
 */
function* rounds(accounts: readonly DirectoryAccount[]): Generator<DirectoryAccount[]> {
  let round: DirectoryAccount[] = [];
  let addresses = 0;
  for (const account of accounts) {
    if (round.length > 0 && addresses + account.addresses.length > ADDRESSES_PER_ROUND) {
      yield round;
      round = [];
      addresses = 0;
    }
    round.push(account);
    addresses += account.addresses.length;
  }
  if (round.length > 0) yield round;
}

/**
 * Which accounts there are, what each is called, and who holds it — the join
 * both reads share, so the two can never disagree about which accounts exist.
 *
 * No history is read here, for either caller. What each account last did is the
 * stream's own second read, over the message stores.
 */
async function observeAccounts(deps: AccountDirectoryDeps): Promise<DirectoryAccount[]> {
  const [senders, persons] = await Promise.all([
    // The triage record, for the senders it is the only source of: a channel
    // Rome mirrors no address book for has no other row saying the account
    // exists. Only that it saw them is read here; what they said is a message
    // store's answer.
    deps.sentinelLogRepo.listSenders(),
    // One statement, so an account moving between two people mid-read cannot
    // land under both of them.
    deps.personMappingRepo.findAllWithMappings(),
  ]);

  const mappings = persons.flatMap((person) =>
    person.channelMappings.map((mapping) => ({ ...mapping, person })),
  );
  const fold = await foldAccounts(addressBooks(deps.channels), {
    stored: [...senders, ...mappings],
  });

  /** Who holds each account, decided once before any row is built. */
  const linkOf = new Map<string, AccountLink>();
  // The account behind every address the three sources name, each one under the
  // address the channel folds it onto.
  const observed = new Map<
    string,
    { channel: string; channelUserId: string; addresses: string[] }
  >();
  const observe = (channel: string, channelUserId: string, addresses?: string[]) => {
    const key = fold.key(channel, channelUserId);
    if (!observed.has(key)) {
      const own = fold.canonical(channel, channelUserId);
      observed.set(key, {
        channel,
        channelUserId: own,
        // A channel with no address book can say nothing about which
        // addresses are the same account, so an address it named is an
        // account of its own.
        addresses: [...(addresses ?? [own])].sort(compareCodePoints),
      });
    }
    return key;
  };

  for (const account of fold.accounts) {
    observe(account.channel, account.channelUserId, account.aliases);
  }
  for (const sender of senders) observe(sender.channel, sender.channelUserId);
  for (const mapping of mappings) {
    const key = observe(mapping.channel, mapping.channelUserId);
    const held = linkOf.get(key);
    if (held && !outranks(mapping.person.id, held.personId)) continue;
    linkOf.set(key, { personId: mapping.person.id, displayName: mapping.person.displayName });
  }

  const rows = [...observed];
  // One naming read for the whole directory: every mirror answers from a single
  // fold of its address book, and the sentinel log's push names are read once,
  // and only where a mirror left a name unanswered.
  const names = await deps.accountNames.displayNames(rows.map(([, account]) => account));

  return rows.map(([key, account], i) => ({
    ...account,
    displayName: names[i],
    ...accountPresentation(linkOf.get(key)),
  }));
}

/**
 * Whether a claim on an account beats the one already held.
 *
 * A real person outranks the stranger sentinel. The unique index already holds
 * one mapping per identifier, but two mappings can name two addresses of one
 * account, and that account is one row: a placement the guardian made is what
 * it should say, and reading the dismissal of a second address instead would
 * hide someone they already placed. Among real people the lowest id wins, so
 * the answer does not depend on read order.
 */
function outranks(personId: string, held: string): boolean {
  if (personId === STRANGER_PERSON_ID) return false;
  if (held === STRANGER_PERSON_ID) return true;
  return compareCodePoints(personId, held) < 0;
}
