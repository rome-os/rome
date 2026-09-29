/**
 * A channel's address book. A channel's `send` and `inbound` ports
 * (channel.ts) move messages; this is who a channel can reach, and which of the identifiers a channel hands out
 * name one and the same account. Vocabulary: docs/concepts/people.md.
 *
 * An account answers *who*. What was said to it — a last message, a count, a
 * preview — is a separate read over the same addresses, and it belongs to
 * `Messages` (messages.ts) rather than here.
 */

/** Opaque provider-owned account address. Callers may persist and round-trip
 * this value, but must never parse, construct, or compare parts of one. */
export type AccountId = string & { readonly __brand: "AccountId" };

export interface Account {
  id: AccountId;
  /**
   * Every address the account answers to, `id` among them.
   *
   * The address set a channel folds onto one account: a WhatsApp contact
   * answers to both a phone JID and a `@lid` JID, and history hangs off
   * either. A caller that has to show or match every form an account can be
   * reached at reads them here rather than asking the channel a second time.
   *
   * The addresses the channel holds, which is not every address it accepts. A
   * form absent here may still resolve — a LinkedIn profile URL naming a
   * member id — and {@link Accounts.resolve} is what takes it.
   */
  addresses: string[];
  /**
   * What the platform calls the account, or null when it holds no name for it.
   *
   * Never an identifier standing in for a name. A caller that has to render
   * something falls back on its own terms — to a name the account's sender put
   * on a message, or to an identifier written for a human — and it cannot
   * choose if a name and a rendered identifier arrive as one value.
   */
  name: string | null;
  /**
   * Searchable facts. Never used to address the account.
   *
   * `email`, `phone`, `username` and `profile_url` are reserved and mean the
   * same thing on every channel. Every other key is namespaced by its channel
   * — `whatsapp:lid`, `linkedin:member_id`. One value per key: an account
   * holding a second value of the same kind qualifies the key (`email:work`).
   */
  identifiers: Record<string, string>;
}

/**
 * Who a channel can reach.
 *
 * The four invariants below are the contract. The types cannot carry them, and
 * every implementation owes all four:
 *
 * - **I1 Uniqueness.** Exactly one {@link Account} per real account. The same
 *   `id` means the same account. Callers never fold aliases themselves.
 * - **I2 Stability.** `id` does not change for the life of the account — not
 *   across a restart, a re-sync, a message arriving on a different address,
 *   or a change to any identifier the account is reachable on.
 * - **I3 Opacity.** Callers never parse or construct an `id`. This is what lets
 *   a channel change its canonical form later without touching a consumer.
 * - **I4 Total resolution.** Every identifier the channel can receive a message
 *   on resolves to that account's `id`.
 */
export interface Accounts {
  /**
   * One page of the channel's accounts, in a stable order. `query` matches the
   * name and the identifier values. `cursor` is opaque and comes from a prior
   * page. A missing `nextCursor` means the listing is exhausted.
   *
   * The order is stable, the listing underneath it is not. A channel may order
   * by activity, so an account can move between two pages and be skipped or
   * repeated. A caller that needs every account exactly once asks for one page
   * large enough to hold the listing.
   *
   * Each account carries its own {@link Account.addresses}, so this is also how
   * a caller learns which addresses fold together. There is no separate
   * address map to ask for: a second answer to a question the listing already
   * answers is a second answer to disagree with.
   */
  listAccounts(input: {
    query?: string;
    cursor?: string;
    limit: number;
  }): Promise<{ accounts: Account[]; nextCursor?: string }>;

  /** The account an address belongs to, or null. Accepts any address the
   *  channel can receive on — and an {@link AccountId}, which round-trips. */
  resolve(address: string): Promise<Account | null>;
}
