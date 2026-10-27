// Every account Rome has observed, in the shape the account contract puts on
// the wire (@rome/api-types/people). Four sources, folded into one list: the
// links and dismissals the guardian has made, the sentinel log's senders, and
// the address books Rome mirrors.
//
// An account is one person on one platform, whatever addresses that platform
// reaches them at. Which of them fold together is the address book's own
// answer, read once through `AccountFold` (../channels/account-fold.ts), so
// nothing here is platform-specific and adding a mirror changes nothing in this
// file. The sentinel log still names the channel a sender wrote on, so its
// rows are read as accounts on that channel's platform where they are folded.
//
// Two reads, because the two surfaces ask two questions — "who does Rome know"
// and "who has something new". They fold the same address books to decide which
// addresses are one account, and only the stream goes on to read a history.

import {
  accountPresentation,
  compareCodePoints,
  latestDynamic,
  type AccountLink,
  type DirectoryAccount,
  type StreamAccount,
} from "@rome/api-types/people";
import type { Account } from "@rome-os/app-runtime";
import type { Message } from "@rome/api-types/message";
import type { AccountNames } from "../channels/account-names.js";
import { foldAccounts } from "../channels/account-fold.js";
import {
  addressBooks,
  channelsOn,
  type Channels,
  type PlatformOfChannel,
} from "../channels/channel.js";
import type { MessageAccount } from "../channels/messages.js";
import type { DrizzleDb } from "../db/index.js";
import type { PeopleRepository } from "../db/repositories/people.js";
import type { SentinelLogRepository } from "../db/repositories/sentinel-log.js";
import { assignAccountHeads } from "./timeline.js";
import { personMessageStores } from "./timeline-sources.js";

export interface AccountDirectoryDeps {
  /** Every channel Rome mirrors — the address books this folds, and the stores
   *  the stream reads a history from. */
  channels: Channels;
  peopleRepo: Pick<PeopleRepository, "all" | "dismissals">;
  sentinelLogRepo: Pick<SentinelLogRepository, "listSenders">;
  accountNames: Pick<AccountNames, "displayNames">;
  platformOfChannel: PlatformOfChannel;
  /** Where the message stores live. Read by the stream alone — the contacts
   *  list never reaches a history. */
  db: DrizzleDb;
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
  const accounts = await readAccountDirectory(deps);
  return streamRows(accounts, await readHeads(deps, accounts));
}

/**
 * {@link readAccountStream} for a caller that asks again before the last read
 * finished. The People page polls the stream every 30 seconds and refetches
 * every page it has loaded, and the head reads can take a while on a slow live
 * store, so without sharing, reads pile up faster than they finish.
 *
 * Only the head reads are shared, never the directory. The directory carries
 * every link and dismissal and is cheap to read, so each read takes it fresh:
 * a refetch right after a write shows that write even while it joins heads a
 * read started before it. Heads depend on nothing but an account's channel and
 * addresses, so each one in flight is shared by that key: a read joins the
 * heads already being read and starts one read for the rest, which later reads
 * join in turn. Nothing is kept once a head read settles, failed or not.
 */
export function accountStreamReader(deps: AccountDirectoryDeps): () => Promise<StreamAccount[]> {
  const inFlight = new Map<string, Promise<Message | undefined>>();

  async function heads(accounts: readonly DirectoryAccount[]): Promise<Map<string, Message>> {
    const keys = accounts.map(headKey);
    const missing = accounts.filter((_, i) => !inFlight.has(keys[i]!));
    if (missing.length > 0) {
      const read = readHeads(deps, missing);
      const started = missing.map((account) => {
        const key = headKey(account);
        const head = read.then((found) => found.get(key));
        inFlight.set(key, head);
        return [key, head] as const;
      });
      const settle = () => {
        for (const [key, head] of started) if (inFlight.get(key) === head) inFlight.delete(key);
      };
      read.then(settle, settle);
    }
    // Taken before any await, so a read that settles meanwhile cannot drop one.
    const pending = keys.map((key) => inFlight.get(key)!);
    const found = await Promise.all(pending);
    return new Map(keys.flatMap((key, i) => (found[i] ? [[key, found[i]] as const] : [])));
  }

  return async () => {
    const accounts = await readAccountDirectory(deps);
    return streamRows(accounts, await heads(accounts));
  };
}

/** What a head read depends on: the platform and every address of the account. */
function headKey(account: DirectoryAccount): string {
  return JSON.stringify([account.channel, [...account.addresses].sort(compareCodePoints)]);
}

/**
 * Each account's head, by {@link headKey}: the entry that claims it, through
 * the same `assignAccountHeads` the person's own page and the people listing
 * settle ownership with. Read in rounds rather than all at once — see
 * {@link ADDRESSES_PER_ROUND}.
 */
async function readHeads(
  deps: AccountDirectoryDeps,
  accounts: readonly DirectoryAccount[],
): Promise<Map<string, Message>> {
  const stores = personMessageStores(deps);
  const heads = new Map<string, Message>();
  // An account is read under every channel on its platform, as a person's
  // timeline is (`timelineAccounts`).
  const storedUnder = (platform: string) =>
    channelsOn(deps.channels, deps.platformOfChannel, platform);
  for (const round of rounds(accounts)) {
    const asked = new Map<MessageAccount, DirectoryAccount>(
      round.map((account) => [
        {
          channel: account.channel,
          addresses: account.addresses,
          storedUnder: storedUnder(account.channel),
        },
        account,
      ]),
    );
    for (const [account, owned] of await assignAccountHeads(stores, [...asked.keys()])) {
      heads.set(headKey(asked.get(account)!), owned.head);
    }
  }
  return heads;
}

/** The directory as stream rows: each account with its head's dynamic, and
 *  without the accounts that have none. */
function streamRows(
  accounts: readonly DirectoryAccount[],
  heads: ReadonlyMap<string, Message>,
): StreamAccount[] {
  return accounts.flatMap((account) => {
    const head = heads.get(headKey(account));
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
 * {@link readAccountStream} is the read that does, and it starts from this
 * join so the two can never disagree about which accounts exist.
 */
export async function readAccountDirectory(
  deps: AccountDirectoryDeps,
): Promise<DirectoryAccount[]> {
  const [senders, persons, dismissals] = await Promise.all([
    // The triage record, for the senders it is the only source of: a channel
    // Rome mirrors no address book for has no other row saying the account
    // exists. Only that it saw them is read here; what they said is a message
    // store's answer.
    deps.sentinelLogRepo.listSenders(),
    // One statement, so an account moving between two people mid-read cannot
    // land under both of them.
    deps.peopleRepo.all(),
    deps.peopleRepo.dismissals(),
  ]);

  const heard = senders.map((sender) => ({
    platform: deps.platformOfChannel(sender.channel),
    id: sender.channelUserId,
  }));
  const links = persons.flatMap((person) => person.links.map((link) => ({ ...link, person })));
  const fold = await foldAccounts(addressBooks(deps.channels, deps.platformOfChannel), {
    stored: [...heard, ...links, ...dismissals],
  });

  /** Who holds each account, decided once before any row is built. */
  const linkOf = new Map<string, AccountLink>();
  // The account behind every address the three sources name, each one under the
  // address the platform's address book folds it onto.
  const observed = new Map<string, { account: Account; addresses: string[] }>();
  const observe = (platform: string, address: string, addresses?: string[]) => {
    const key = fold.key(platform, address);
    if (!observed.has(key)) {
      const own = fold.canonical(platform, address);
      observed.set(key, {
        account: { platform, id: own },
        // A platform with no address book can say nothing about which
        // addresses are the same account, so an address it named is an
        // account of its own.
        addresses: [...(addresses ?? [own])].sort(compareCodePoints),
      });
    }
    return key;
  };

  for (const account of fold.accounts) observe(account.platform, account.id, account.aliases);
  for (const sender of heard) observe(sender.platform, sender.id);
  for (const link of links) {
    const key = observe(link.platform, link.id);
    const held = linkOf.get(key);
    if (held && !outranks(link.person.id, held)) continue;
    linkOf.set(key, { personId: link.person.id, displayName: link.person.displayName });
  }
  // A dismissal of one address never hides a link on another address of the
  // same account: a placement the guardian made is what the row should say.
  for (const dismissal of dismissals) {
    const key = observe(dismissal.platform, dismissal.id);
    if (!linkOf.has(key)) linkOf.set(key, { dismissed: true });
  }

  const rows = [...observed];
  // One naming read for the whole directory: every mirror answers from a single
  // fold of its address book, and the sentinel log's push names are read once,
  // and only where a mirror left a name unanswered.
  const names = await deps.accountNames.displayNames(rows.map(([, row]) => row.account));

  // On the wire an account is still a channel and an address, and the channel
  // a link names is its platform.
  return rows.map(([key, row], i) => ({
    channel: row.account.platform,
    channelUserId: row.account.id,
    addresses: row.addresses,
    displayName: names[i],
    ...accountPresentation(linkOf.get(key)),
  }));
}

/**
 * Whether a link on an account beats the one already held.
 *
 * The unique index holds one link per address, but two links can name two
 * addresses of one account, and that account is one row. The lowest person id
 * wins, so the answer does not depend on read order.
 */
function outranks(personId: string, held: AccountLink): boolean {
  return "dismissed" in held || compareCodePoints(personId, held.personId) < 0;
}
