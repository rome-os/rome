// Which stores a person's history comes from, and the order they claim an
// account in. The stores themselves are the channels' — one `AccountMessages` adapter
// each, in channels/ — and the merge over them is timeline.ts's.
//
// Also the fold from a person's links to the accounts those stores are read
// for, since the two are the same question asked of one platform: which
// addresses are one account, and what was said at them.
//
// Vocabulary: docs/concepts/people.md.
//
// Direct threads only. Each store scopes itself by the account's own addresses,
// so a group conversation — addressed by the group rather than by the person —
// never reaches a person's timeline.

import type { Account } from "@rome-os/app-runtime";
import { platformOf } from "@rome/api-types/platform";
import { foldAccounts, type AccountFold, type AddressBooks } from "../channels/account-fold.js";
import {
  addressBooks,
  storedOn,
  type RecordedOn,
  messageStores,
  type Channels,
  type PlatformOfChannel,
} from "../channels/channel.js";
import type { AccountMessages, MessageAccount } from "../channels/messages.js";
import { agentMessages } from "../channels/messages-agent.js";
import { sentinelLogMessages } from "../channels/messages-sentinel.js";
import type { DrizzleDb } from "../db/index.js";

/**
 * The stores a person's history is read from, in the order they claim an
 * account — the list `assignAccounts` walks, for the page and for the listing
 * row alike.
 *
 * The order is a precedence: a channel's own store answers for the conversation
 * as the channel has it, so every one of them outranks Rome's transcript of
 * the same messages, which in turn outranks the sentinel's triage record. An
 * account only the sentinel saw still gets its exchanges — the sentinel is
 * last, not excluded.
 *
 * The cost of that precedence: an account whose channel answers for the
 * conversation shows the conversation, and the sentinel's own record of an exchange inside it
 * stays behind Rome's reply as the channel delivered it.
 *
 * A channel joins by answering for a history, which is an entry in the channel list
 * (channel-list.ts). Rome's own two stores belong to no channel and answer for
 * every one, which is why they are named here and sit behind all of them.
 */
export function personMessageStores(deps: {
  db: DrizzleDb;
  channels: Channels;
}): AccountMessages[] {
  return [...messageStores(deps.channels), agentMessages(deps.db), sentinelLogMessages(deps.db)];
}

/**
 * Every account each group of links is reachable at, with every address the
 * platform's address book folds onto it — one result per group, in the order
 * given.
 *
 * Each account keeps the platform its link names as `channel`, and is read
 * under every channel on that platform (`platformOfChannel`, absent the
 * platform of the connection kind a channel is named after): a message is stored under the channel
 * it arrived on, and an account hears from Rome on any of Rome's accounts on
 * its platform, so one timeline holds what was said on all of them.
 *
 * Two links that name two addresses of one account collapse to one account, so
 * a person linked under both a WhatsApp phone JID and its `@lid` form reads one
 * timeline rather than two halves of one.
 *
 * A platform with no address book contributes the link's own address and
 * nothing else, which is all Rome can say about who it can reach there.
 *
 * Positional and over every group at once, like `AccountNames.displayNames`
 * next door: each address book costs a full read, so one caller asking about a
 * directory of people must not pay for one read per row.
 */
export async function timelineAccounts(
  deps: { channels: Channels; platformOfChannel?: PlatformOfChannel; recordedOn?: RecordedOn },
  groups: readonly (readonly Account[])[],
): Promise<MessageAccount[][]> {
  const links = groups.flat();
  const platformOfChannel = deps.platformOfChannel ?? platformOf;
  const fold = await foldAccounts(booksNamed(deps.channels, platformOfChannel, links), {
    stored: links,
  });
  const stored = new Map<string, string[]>();
  const storedUnder = (platform: string) => {
    let names = stored.get(platform);
    if (!names) {
      names = storedOn(deps.channels, platformOfChannel, platform, deps.recordedOn);
      stored.set(platform, names);
    }
    return names;
  };
  return groups.map((group) => accountsOf(fold, storedUnder, group));
}

/** The address books of the platforms the links name, and nothing else. An
 *  address book costs a full read, and a platform no link names folds nothing,
 *  so a person on one platform pays for one book rather than for the list. */
function booksNamed(
  channels: Channels,
  platformOfChannel: PlatformOfChannel,
  links: readonly Account[],
): AddressBooks {
  const named = new Set(links.map((link) => link.platform));
  return Object.fromEntries(
    Object.entries(addressBooks(channels, platformOfChannel)).filter(([platform]) =>
      named.has(platform),
    ),
  );
}

/** One group's links as the accounts they reach, keyed by the account rather
 *  than by the address a link happened to name, so two links onto one account
 *  are one entry per channel it is stored under (see {@link perChannel}). */
function accountsOf(
  fold: AccountFold,
  storedUnder: (platform: string) => string[],
  links: readonly Account[],
): MessageAccount[] {
  const byAccount = new Map<string, MessageAccount[]>();
  for (const link of links) {
    const key = fold.key(link.platform, link.id);
    if (byAccount.has(key)) continue;
    byAccount.set(
      key,
      perChannel({
        channel: link.platform,
        storedUnder: storedUnder(link.platform),
        // The link's own address among them, whatever the book says: a
        // platform that folds nothing onto it is still read at the address the
        // guardian stored.
        addresses: [
          ...new Set([link.id, ...(fold.accountFor(link.platform, link.id)?.aliases ?? [])]),
        ],
      }),
    );
  }
  return [...byAccount.values()].flat();
}

/**
 * An account read under several channels as one read per channel.
 *
 * A store owns an account's history only as a whole (`assignAccounts`), and
 * what was said on two of Rome's accounts is stored apart: an old transcript
 * under a released channel and a recent triage under a live one. Asked as one,
 * the first store holding either would claim both and drop the other's. Asked
 * per channel, each channel's history is claimed by its own store and the
 * timeline merges them, as it merges a person's accounts.
 */
export function perChannel(account: MessageAccount): MessageAccount[] {
  const names = account.storedUnder ?? [account.channel];
  return names.length <= 1 ? [account] : names.map((name) => ({ ...account, storedUnder: [name] }));
}
