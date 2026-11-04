// Every account Rome has observed, in the shape the account contract puts on
// the wire (@rome/api-types/people). Four sources, folded into one list: the
// links and dismissals the guardian has made, the sentinel log's senders, and
// the address books Rome mirrors.
//
// An account is one person on one platform, whatever addresses that platform
// reaches them at. Which of them fold together is the address book's own
// answer, read once through `AccountFold` (../connected-accounts/account-fold.ts), so
// nothing here is platform-specific and adding a mirror changes nothing in this
// file. The sentinel log still names the channel a sender wrote on, so its
// rows are read as accounts on that channel's platform where they are folded.
//
// A contacts list: who each account is, and nothing about what anyone said.

import {
  accountPresentation,
  compareCodePoints,
  type AccountLink,
  type DirectoryAccount,
} from "@rome/api-types/people";
import type { Account } from "@rome-os/app-runtime";
import type { AccountNames } from "../connected-accounts/account-names.js";
import { foldAccounts } from "../connected-accounts/account-fold.js";
import {
  addressBooks,
  type Channels,
  type PlatformOfChannel,
} from "../connected-accounts/channel.js";
import type { PeopleRepository } from "../db/repositories/people.js";
import type { SentinelLogRepository } from "../db/repositories/sentinel-log.js";

export interface AccountDirectoryDeps {
  /** Every channel Rome mirrors — the address books this folds. */
  channels: Channels;
  peopleRepo: Pick<PeopleRepository, "all" | "dismissals">;
  sentinelLogRepo: Pick<SentinelLogRepository, "listSenders">;
  accountNames: Pick<AccountNames, "displayNames">;
  platformOfChannel: PlatformOfChannel;
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

  const links = persons.flatMap((person) => person.links.map((link) => ({ ...link, person })));
  const fold = await foldAccounts(addressBooks(deps.channels, deps.platformOfChannel), {
    stored: [...senders, ...links, ...dismissals],
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
  for (const sender of senders) observe(sender.platform, sender.id);
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
