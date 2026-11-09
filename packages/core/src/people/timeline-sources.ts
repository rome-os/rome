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
//
// The guardian's chats only. A person's timeline holds what passed between
// their account and the guardian's own connected accounts, the ones linked to
// the guardian. What an agent's own account said to them, and what Rome only
// triaged, belong to those chats and are not read here.

import type { Account } from "@rome-os/app-runtime";
import { platformOf } from "@rome/api-types/platform";
import {
  foldAccounts,
  type AccountFold,
  type AddressBooks,
} from "../chats/accounts/account-fold.js";
import {
  addressBooks,
  storedOn,
  type RecordedOn,
  messageStores,
  type Channels,
  type PlatformOfChannel,
} from "../chats/connected-accounts/connected-account.js";
import type { AccountMessages, MessageAccount } from "../chats/history/messages.js";
import { chatsAgentMessages } from "../chats/history/messages-agent.js";
import type { DrizzleDb } from "../db/index.js";
import type { PeopleRepository } from "../db/repositories/people.js";

/**
 * The stores a person's history is read from, in the order they claim an
 * account — the list `assignAccounts` walks, for the page and for the listing
 * row alike.
 *
 * The order is a precedence: a channel's own store answers for the conversation
 * as the channel has it, so every one of them outranks Rome's transcript of
 * the same messages.
 *
 * The sentinel's triage record is not among them. It is what Rome checked
 * before deciding whether to answer, not a chat with the guardian.
 *
 * A channel joins by answering for a history, which is an entry in the channel list
 * (channel-list.ts). Rome's transcript belongs to no channel and answers for
 * every one, which is why it is named here and sits behind all of them.
 */
export function personMessageStores(deps: {
  db: DrizzleDb;
  channels: Channels;
  platformOfChannel: PlatformOfChannel;
  /** Rome's own account on a channel, or null while its record knows none. */
  accountOf?: (channel: string) => Account | null;
}): AccountMessages[] {
  const transcript = chatsAgentMessages(deps.db, (channel) => deps.accountOf?.(channel) ?? null);
  return [...messageStores(deps.channels), transcript];
}

/**
 * Whether a channel's account is one of the guardian's own: an account linked
 * to the guardian (docs/concepts/people.md#account). A channel whose record
 * knows no account is nobody's, so it is not the guardian's either.
 *
 * Read once per request: the guardian's links are a handful, and every
 * channel a timeline is read under is asked.
 */
export async function guardianChannels(deps: {
  peopleRepo: Pick<PeopleRepository, "all">;
  accountOf?: (channel: string) => Account | null;
}): Promise<(channel: string) => boolean> {
  const guardian = (await deps.peopleRepo.all()).find((person) => person.bondLevel === "guardian");
  const own = new Set((guardian?.links ?? []).map((link) => `${link.platform}\u0000${link.id}`));
  return (channel) => {
    const account = deps.accountOf?.(channel);
    return account != null && own.has(`${account.platform}\u0000${account.id}`);
  };
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
  deps: {
    channels: Channels;
    platformOfChannel?: PlatformOfChannel;
    recordedOn?: RecordedOn;
    /** Which channels are the guardian's own (`guardianChannels`). Absent,
     *  every channel on the platform is read. */
    guardians?: (channel: string) => boolean;
  },
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
      names = storedOn(deps.channels, platformOfChannel, platform, deps.recordedOn).filter(
        (name) => deps.guardians?.(name) ?? true,
      );
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
  const byAccount = new Map<string, { platform: string; addresses: Set<string> }>();
  for (const link of links) {
    const key = fold.key(link.platform, link.id);
    const held = byAccount.get(key);
    // Every link's own address among them, whatever the book says: a platform
    // that folds nothing onto it is still read at the address the guardian
    // stored, and a second link onto the account is matched by its own
    // address even where the book does not list it.
    if (held) {
      held.addresses.add(link.id);
      continue;
    }
    byAccount.set(key, {
      platform: link.platform,
      addresses: new Set([link.id, ...(fold.accountFor(link.platform, link.id)?.aliases ?? [])]),
    });
  }
  return [...byAccount.values()].flatMap((account) =>
    perChannel({
      channel: account.platform,
      storedUnder: storedUnder(account.platform),
      addresses: [...account.addresses],
    }),
  );
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
