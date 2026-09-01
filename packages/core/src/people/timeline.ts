// A person's history, merged across every account they are linked to. The
// entry shape, the ordering and the cursor are the contract's
// (@rome/api-types/people); a store is the channel's (`Messages`, in
// channels/messages.js); this module is only the merge above them.

import {
  compareTimelineEntries,
  isAfterTimelineCursor,
  timelineCursor,
  type TimelineEntry,
  type TimelinePage,
} from "@rome/api-types/people";
import type { MessageAccount, Messages } from "../channels/messages.js";

/**
 * One page of `accounts`' merged history, newest first, resuming after
 * `cursor`.
 *
 * `nextCursor` is null only when the whole remaining history fit. Filter
 * `accounts` before calling to narrow the page to one channel — every entry a
 * store produces belongs to the account it was read for, so the accounts are
 * the only scope there is.
 */
export async function readPersonTimeline(
  stores: readonly Messages[],
  accounts: readonly MessageAccount[],
  options: { cursor?: TimelineEntry | null; limit: number },
): Promise<TimelinePage> {
  const cursor = options.cursor ?? null;
  const limit = Math.max(1, Math.floor(options.limit));

  const pages = await Promise.all(
    // One extra entry per store, which is what makes `nextCursor` honest: a
    // page of exactly `limit` merged entries is otherwise indistinguishable
    // from an exhausted history, and answering null there truncates the
    // timeline at a boundary the client cannot resume past.
    (await assignAccounts(stores, accounts)).map(([store, held]) =>
      store.read({ accounts: held, after: cursor, limit: limit + 1 }),
    ),
  );

  // Every store answered its own newest `limit + 1`, so any of the merged
  // newest `limit` that a store could contribute is among the entries it sent.
  const merged = pages
    .flat()
    .filter((entry) => cursor === null || isAfterTimelineCursor(entry, cursor))
    .sort(compareTimelineEntries);
  const entries = merged.slice(0, limit);
  const oldest = entries.at(-1);
  return {
    entries,
    nextCursor: merged.length > entries.length && oldest ? timelineCursor(oldest) : null,
  };
}

/**
 * Each store paired with the accounts it owns: the first store that holds an
 * account takes it, and no later store is offered it.
 *
 * The rule exists because the stores overlap rather than partition. One inbound
 * WhatsApp message is a `wa_messages` row, a `rome_agent_messages` row on the
 * channel session, and — when the sentinel triaged it — a `sentinel_log` row as
 * well. Merging all three renders one message three times, and the copies carry
 * different ids at different timestamps, so no after-the-fact dedupe survives a
 * page boundary. Instead each account's history comes from exactly one store.
 *
 * Ownership is derived rather than asked for: a store that answers a `latest`
 * for an account is a store that holds it, and `Messages` states that `latest`
 * is the head of the very history `read` pages. A separate "do you hold this"
 * verb would be a second answer to the same question, free to disagree with the
 * first — a row previewing an entry from one store while the page beneath it
 * opens on another's.
 *
 * The one place the rule is applied. Every read of a person's history — the
 * page here, the summary in activity.ts — goes through this, because a summary
 * that claimed accounts on its own terms could count an exchange the page
 * attributes to a different store.
 *
 * One `latest` per account, and the whole store's worth raised before any is
 * awaited: an adapter that groups the calls of a tick — every SQL one does —
 * settles a whole directory's ownership in one pass over the store rather than
 * one per row.
 */
export async function assignAccounts<Account extends MessageAccount>(
  stores: readonly Messages[],
  accounts: readonly Account[],
): Promise<Array<[Messages, Account[]]>> {
  const owned = await assignAccountHeads(stores, accounts);
  const assigned: Array<[Messages, Account[]]> = [];
  for (const store of stores) {
    const held = accounts.filter((account) => owned.get(account)?.store === store);
    if (held.length > 0) assigned.push([store, held]);
  }
  return assigned;
}

/**
 * {@link assignAccounts}, keeping the entry that settled each account rather
 * than only who owns it.
 *
 * The `latest` a store answers is what decides ownership, and it is also the
 * head of the history that store will page — the same entry, by the law
 * `Messages` states. A caller that wants both therefore asks once: the account
 * stream previews exactly what it claims by, and cannot drift from the page it
 * opens onto by reading the two from separate calls.
 *
 * `assignAccounts` is this with the heads dropped, so the ownership rule above
 * is applied in one place whichever of the two a caller needs.
 *
 * Keyed by the given account objects themselves, so a caller reads its answer
 * back off the values it passed in.
 */
export async function assignAccountHeads<Account extends MessageAccount>(
  stores: readonly Messages[],
  accounts: readonly Account[],
): Promise<Map<Account, { store: Messages; head: TimelineEntry }>> {
  const owned = new Map<Account, { store: Messages; head: TimelineEntry }>();
  let unclaimed = [...accounts];
  for (const store of stores) {
    if (unclaimed.length === 0) break;
    const heads = await Promise.all(unclaimed.map((account) => store.latest([account])));
    const next: Account[] = [];
    unclaimed.forEach((account, index) => {
      const head = heads[index];
      if (head == null) next.push(account);
      else owned.set(account, { store, head });
    });
    unclaimed = next;
  }
  return owned;
}
