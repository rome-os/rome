// Which stores a person's history comes from, and the order they claim an
// account in. The stores themselves are the channels' — one `Messages` adapter
// each, in channels/ — and the merge over them is timeline.ts's.
//
// Also the fold from a person's links to the accounts those stores are read
// for, since the two are the same question asked of one channel: which
// addresses are one account, and what was said at them.
//
// Vocabulary: docs/concepts/people.md.
//
// Direct threads only. Each store scopes itself by the account's own addresses,
// so a group conversation — addressed by the group rather than by the person —
// never reaches a person's timeline.

import {
  foldAccounts,
  type AccountFold,
  type AddressBooks,
  type StoredAddress,
} from "../channels/account-fold.js";
import { addressBooks, messageStores, type Channels } from "../channels/channel.js";
import type { MessageAccount, Messages } from "../channels/messages.js";
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
export function personMessageStores(deps: { db: DrizzleDb; channels: Channels }): Messages[] {
  return [...messageStores(deps.channels), agentMessages(deps.db), sentinelLogMessages(deps.db)];
}

/**
 * Every account each group of linked addresses is reachable at, with every
 * address the channel folds onto it — one result per group, in the order given.
 *
 * Two links that name two addresses of one account collapse to one account, so
 * a person linked under both a WhatsApp phone JID and its `@lid` form reads one
 * timeline rather than two halves of one.
 *
 * A channel with no address book contributes the link's own address and nothing
 * else, which is all the channel can say about who it can reach.
 *
 * Positional and over every group at once, like `AccountNames.displayNames`
 * next door: each channel's address book costs a full read, so one caller
 * asking about a directory of people must not pay for one read per row.
 */
export async function timelineAccounts(
  deps: { channels: Channels },
  groups: readonly (readonly StoredAddress[])[],
): Promise<MessageAccount[][]> {
  const links = groups.flat();
  const fold = await foldAccounts(booksNamed(deps.channels, links), { stored: links });
  return groups.map((group) => accountsOf(fold, group));
}

/** The address books of the channels the links name, and nothing else. An
 *  address book costs a full read, and a channel no link names folds nothing,
 *  so a person on one channel pays for one book rather than for the list. */
function booksNamed(channels: Channels, links: readonly StoredAddress[]): AddressBooks {
  const named = new Set(links.map((link) => link.channel));
  return Object.fromEntries(
    Object.entries(addressBooks(channels)).filter(([channel]) => named.has(channel)),
  );
}

/** One group's links as the accounts they reach, keyed by the account rather
 *  than by the address a link happened to name, so two links onto one account
 *  are one entry. */
function accountsOf(fold: AccountFold, links: readonly StoredAddress[]): MessageAccount[] {
  const byAccount = new Map<string, MessageAccount>();
  for (const link of links) {
    const key = fold.key(link.channel, link.channelUserId);
    if (byAccount.has(key)) continue;
    byAccount.set(key, {
      channel: link.channel,
      // The link's own address among them, whatever the book says: a channel
      // that folds nothing onto it is still read at the address the guardian
      // stored.
      addresses: [
        ...new Set([
          link.channelUserId,
          ...(fold.accountFor(link.channel, link.channelUserId)?.aliases ?? []),
        ]),
      ],
    });
  }
  return [...byAccount.values()];
}
