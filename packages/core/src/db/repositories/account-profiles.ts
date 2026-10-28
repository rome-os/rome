import type { Account } from "@rome-os/app-runtime";
import { and, eq, inArray, sql } from "drizzle-orm";
import type { DrizzleDb } from "../index.js";
import { accountProfiles } from "../schema.js";

/** What a platform says about an account. Every field is null where the
 *  platform said nothing. */
export interface AccountProfile {
  displayName: string | null;
  handle: string | null;
  avatarUrl: string | null;
}

/**
 * The account profile cache (docs/domains/chats.md#account-profile), keyed by
 * the `Account` value.
 *
 * Two writers, ranked. An address book states what the platform holds for the
 * account, and its row replaces whatever was there. A message states what its
 * sender called themselves when they sent it, and it writes only where no
 * address book has: a saved contact name outranks the name a sender gives.
 */
export class AccountProfilesRepository {
  constructor(private readonly db: DrizzleDb) {}

  /** Record what an address book holds for each of `profiles`' accounts. */
  async fromAddressBook(
    profiles: Array<{ account: Account } & AccountProfile>,
    now = new Date(),
  ): Promise<void> {
    if (profiles.length === 0) return;
    // One statement per batch keeps a large address book under SQLite's
    // variable limit.
    for (let start = 0; start < profiles.length; start += BATCH) {
      const rows = profiles.slice(start, start + BATCH).map((profile) => ({
        ...rowOf(profile.account, profile),
        source: "address_book" as const,
        updatedAt: now,
      }));
      await this.db
        .insert(accountProfiles)
        .values(rows)
        .onConflictDoUpdate({
          target: [accountProfiles.platform, accountProfiles.accountId],
          set: {
            displayName: sql`excluded.display_name`,
            handle: sql`excluded.handle`,
            avatarUrl: sql`excluded.avatar_url`,
            source: sql`excluded.source`,
            updatedAt: sql`excluded.updated_at`,
          },
        });
    }
  }

  /** Record what a sender put on a message, unless an address book has already
   *  spoken for the account. */
  async fromMessage(account: Account, profile: AccountProfile, now = new Date()): Promise<void> {
    await this.db
      .insert(accountProfiles)
      .values({ ...rowOf(account, profile), source: "message", updatedAt: now })
      .onConflictDoUpdate({
        target: [accountProfiles.platform, accountProfiles.accountId],
        set: {
          displayName: sql`coalesce(excluded.display_name, ${accountProfiles.displayName})`,
          handle: sql`coalesce(excluded.handle, ${accountProfiles.handle})`,
          avatarUrl: sql`coalesce(excluded.avatar_url, ${accountProfiles.avatarUrl})`,
          updatedAt: sql`excluded.updated_at`,
        },
        setWhere: eq(accountProfiles.source, "message"),
      });
  }

  /** The profile of each account, positionally, or null for an account the
   *  cache has learned nothing about. */
  async profilesOf(accounts: Account[]): Promise<Array<AccountProfile | null>> {
    if (accounts.length === 0) return [];
    const found = new Map<string, AccountProfile>();
    const byPlatform = new Map<string, Set<string>>();
    for (const account of accounts) {
      const ids = byPlatform.get(account.platform) ?? new Set<string>();
      byPlatform.set(account.platform, ids.add(account.id));
    }
    for (const [platform, idSet] of byPlatform) {
      const ids = [...idSet];
      for (let start = 0; start < ids.length; start += BATCH) {
        const rows = await this.db
          .select()
          .from(accountProfiles)
          .where(
            and(
              eq(accountProfiles.platform, platform),
              inArray(accountProfiles.accountId, ids.slice(start, start + BATCH)),
            ),
          );
        for (const row of rows) {
          found.set(keyOf({ platform: row.platform, id: row.accountId }), {
            displayName: row.displayName,
            handle: row.handle,
            avatarUrl: row.avatarUrl,
          });
        }
      }
    }
    return accounts.map((account) => found.get(keyOf(account)) ?? null);
  }
}

const BATCH = 200;

const keyOf = (account: Account) => `${account.platform}\n${account.id}`;

function rowOf(account: Account, profile: AccountProfile) {
  return {
    platform: account.platform,
    accountId: account.id,
    displayName: profile.displayName,
    handle: profile.handle,
    avatarUrl: profile.avatarUrl,
  };
}
