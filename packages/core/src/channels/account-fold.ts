// Who is one account — every address book Rome reads, folded onto accounts.
//
// `Accounts` (accounts.ts) is one channel's address book and `AccountNames`
// (account-names.ts) is the display-name half of all of them. This is the fold
// underneath both reads that have to show every account there is: which
// addresses are one account. Vocabulary: docs/concepts/people.md.
//
// Nothing here reads a history. What an account last did is a `Messages` store's
// answer (messages.ts), read by the callers that show it, so the contacts list
// never touches a message store to learn who exists.

import { compareCodePoints } from "@rome/api-types/people";
import type { Account } from "@rome-os/app-runtime";
import type { Accounts } from "./accounts.js";

/**
 * One account a channel's address book holds, in the shape every caller reads
 * every channel through.
 *
 * The projection is `Account` as the fold reads it, and nothing channel-specific
 * survives it: which addresses a channel hands out, which of them is
 * canonical, and what counts as an account at all are the channel's answers,
 * given once behind {@link Accounts}. So a caller's rules stay
 * channel-agnostic, and adding a channel is an entry in the channel list
 * (channel-list.ts) rather than another special case above.
 */
export interface FoldedAccount {
  /** The platform the account lives on, which its address book is filed
   *  under (`addressBooks`). */
  platform: string;
  /** The account's own address: what a link or a stored row should name. */
  id: string;
  /** Every address the account answers to, `id` included. */
  aliases: string[];
  /** What the channel calls the account, or null when it holds no name. */
  name: string | null;
}

/** Key a (platform, address) pair for the maps a fold is built out of. */
export const addressKey = (platform: string, address: string) => `${platform}\n${address}`;

/**
 * The platforms a fold reads, each behind its own address book.
 *
 * An address book is read as its listing gives it — each account carrying its
 * own address set — so the whole book arrives as accounts rather than as a map
 * of addresses a caller has to invert back into them.
 */
export type AddressBooks = Readonly<Record<string, Accounts>>;

/** An address a caller already holds, wherever it holds it — a link, a
 *  sentinel row — so a platform's address book can be asked about the ones it
 *  does not list. */
export type StoredAddress = Account;

/**
 * Every account the address books hold, folded so that one account answers
 * under every address it is reachable at.
 *
 * Built by {@link foldAccounts}. A caller asks it questions about a (platform,
 * address) pair and never has to know which of them the channel considers
 * canonical. Nothing here is about what anybody said: a `Messages` store is
 * what answers that, for the callers that ask.
 */
export class AccountFold {
  constructor(
    /** Every account the address books hold. */
    readonly accounts: readonly FoldedAccount[],
    protected readonly byAddress: ReadonlyMap<string, FoldedAccount>,
  ) {}

  /**
   * The address the channel folds this one onto, or the address itself on a
   * channel that holds no address book.
   *
   * Which addresses fold together is the channel's answer, not a rule derived
   * here: it is the address book read as given. Without it the same person is
   * both a linked account (under the address a link named) and an unplaced
   * sender (a sentinel row under another) — two rows a caller cannot merge and
   * the guardian cannot tell apart.
   */
  canonical(platform: string, address: string): string {
    return this.byAddress.get(addressKey(platform, address))?.id ?? address;
  }

  /** The key every map in a fold is keyed by: the account, not the address the
   *  caller happened to name. */
  key(platform: string, address: string): string {
    return addressKey(platform, this.canonical(platform, address));
  }

  /** The channel's account for an address, or undefined on a channel that holds
   *  no address book. */
  accountFor(platform: string, address: string): FoldedAccount | undefined {
    return this.byAddress.get(this.key(platform, address));
  }
}

/**
 * Read every address book whole and fold it.
 *
 * Whole rather than paged: a caller pages its own answer, and an account past a
 * channel's own cutoff is one the guardian cannot find and no count includes.
 * The fold that decides which addresses are one account needs every address
 * book entire in any case.
 *
 * No history is read here — not a channel's and not the triage record's. This is
 * what a contacts list needs and the whole of it, so the read that serves one
 * never reaches a message store.
 *
 * `stored` is every address the caller already holds. The channels are read
 * concurrently, and each channel's reads are issued in one batch, because an
 * address book that folds itself whole per call shares the read already in
 * flight — so the whole fold costs one read per channel rather than one per
 * call made against it.
 */
export async function foldAccounts(
  books: AddressBooks,
  input: { stored: readonly StoredAddress[] },
): Promise<AccountFold> {
  const read = await readAddressBooks(books, input.stored);
  return new AccountFold(read.accounts, read.byAddress);
}

/** Every channel read concurrently, and their address books merged into one
 *  fold. */
async function readAddressBooks(
  books: AddressBooks,
  storedAddresses: readonly StoredAddress[],
): Promise<{ accounts: FoldedAccount[]; byAddress: Map<string, FoldedAccount> }> {
  // One entry per (platform, address): the sources overlap — a link and a
  // sentinel row routinely name the same address — and each one asks its
  // platform's book a question.
  const stored = new Map<string, StoredAddress>();
  for (const address of storedAddresses) {
    stored.set(addressKey(address.platform, address.id), address);
  }

  const reads = await Promise.all(
    Object.entries(books).map(([platform, book]) =>
      readAddressBook(
        platform,
        book,
        [...stored.values()].filter((address) => address.platform === platform),
      ),
    ),
  );

  const accounts: FoldedAccount[] = [];
  const byAddress = new Map<string, FoldedAccount>();
  for (const read of reads) {
    accounts.push(...read.accounts);
    for (const [address, account] of read.byAddress) byAddress.set(address, account);
  }
  return { accounts, byAddress };
}

/** One channel's address book, projected and indexed under every address its
 *  accounts answer to. */
async function readAddressBook(
  platform: string,
  book: Accounts,
  stored: readonly StoredAddress[],
): Promise<{ accounts: FoldedAccount[]; byAddress: Map<string, FoldedAccount> }> {
  // Every read this channel owes, issued in one batch so the address book
  // serves them all from a single fold of itself. The stored addresses are
  // resolved without waiting to learn which of them the listing already covers:
  // a channel can accept an address it stores no row for — LinkedIn derives a
  // member id from a profile URL naming it — and asking after the listing
  // arrived would fall outside the shared read and cost a second fold of the
  // whole address book.
  const [listing, resolved] = await Promise.all([
    book.listAccounts({ limit: WHOLE_LISTING }),
    Promise.all(stored.map((address) => book.resolve(address.id))),
  ]);

  const accounts: FoldedAccount[] = [];
  const byAddress = new Map<string, FoldedAccount>();
  const byId = new Map<string, FoldedAccount>();
  for (const account of listing.accounts) {
    const folded: FoldedAccount = {
      platform,
      id: account.id,
      // The account's own address set, as the channel gave it. An account
      // carries all of them because a search reads them: an omitted address is
      // a contact the guardian cannot reach by the phone number they know. An
      // account the channel holds no address for still answers to its id.
      aliases: (account.addresses.length > 0 ? [...account.addresses] : [account.id]).sort(
        compareCodePoints,
      ),
      name: account.name,
    };
    accounts.push(folded);
    byId.set(account.id, folded);
    for (const alias of folded.aliases) byAddress.set(addressKey(platform, alias), folded);
  }

  // A stored address no listed account named. Left unfolded, a link written in
  // that form is a second account for someone the caller already lists, and
  // half their history hangs off it. The address stays as the caller gave it:
  // this is the fold, not a new alias to publish.
  stored.forEach((address, i) => {
    if (byAddress.has(addressKey(platform, address.id))) return;
    const found = resolved[i];
    const account = found && byId.get(found.id);
    if (account) byAddress.set(addressKey(platform, address.id), account);
  });

  return { accounts, byAddress };
}

/**
 * One page big enough to hold any listing — what `Accounts.listAccounts`
 * says to ask for when a caller needs every account exactly once. Its order is
 * stable but the listing under it is not, so walking cursors across a live
 * address book would skip or repeat an account as an inbound message reordered
 * it.
 */
const WHOLE_LISTING = Number.MAX_SAFE_INTEGER;
