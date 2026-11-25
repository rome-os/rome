// The tables behind Identity: the people Rome knows and which accounts are
// theirs. Vocabulary: docs/domains/identity.md.

import { and, eq } from "drizzle-orm";
import type { DrizzleDb, DrizzleTx } from "../db/index.js";
import { identities, identityAccounts } from "../db/schema.js";

type Exec = DrizzleDb | DrizzleTx;

/** An account, by its platform and the platform's own id. */
export interface PlatformAccount {
  platform: string;
  accountId: string;
}

/** A person Rome knows. */
export interface Identity {
  id: string;
  name: string | null;
  avatarUrl: string | null;
}

const IDENTITY_COLUMNS = {
  id: identities.id,
  name: identities.name,
  avatarUrl: identities.avatarUrl,
};

/** Reads and writes `identities` and `identity_accounts`. Each write that
 *  checks who holds an account runs in one transaction with its check. */
export class IdentityRepository {
  constructor(private readonly db: DrizzleDb) {}

  personOf(account: PlatformAccount): Identity | null {
    return (
      this.db
        .select(IDENTITY_COLUMNS)
        .from(identityAccounts)
        .innerJoin(identities, eq(identities.id, identityAccounts.identityId))
        .where(accountIs(account))
        .get() ?? null
    );
  }

  accountsOf(identityId: string): PlatformAccount[] {
    return this.db
      .select({ platform: identityAccounts.platform, accountId: identityAccounts.accountId })
      .from(identityAccounts)
      .where(eq(identityAccounts.identityId, identityId))
      .orderBy(identityAccounts.platform, identityAccounts.accountId)
      .all();
  }

  /** Inserts `identity` with `accounts` as theirs, unless one of the accounts
   *  belongs to someone. Returns the first such account, having written
   *  nothing, or null once both are written. */
  insert(identity: Identity, accounts: PlatformAccount[], now: Date): PlatformAccount | null {
    return this.db.transaction((tx) => {
      const taken = accounts.find((account) => holderOf(tx, account) !== null);
      if (taken) return taken;
      tx.insert(identities)
        .values({ ...identity, createdAt: now })
        .run();
      for (const account of accounts) {
        tx.insert(identityAccounts)
          .values({ ...account, identityId: identity.id, createdAt: now })
          .onConflictDoNothing()
          .run();
      }
      return null;
    });
  }

  /** Gives `account` to `identityId` unless another person holds it. Returns
   *  the holder's id when someone else holds it, else null. */
  insertAccount(identityId: string, account: PlatformAccount, now: Date): string | null {
    return this.db.transaction((tx) => {
      const holder = holderOf(tx, account);
      if (holder !== null) return holder === identityId ? null : holder;
      tx.insert(identityAccounts)
        .values({ ...account, identityId, createdAt: now })
        .run();
      return null;
    });
  }

  deleteAccount(account: PlatformAccount): void {
    this.db.delete(identityAccounts).where(accountIs(account)).run();
  }

  update(identityId: string, patch: { name?: string | null; avatarUrl?: string | null }): void {
    if (patch.name === undefined && patch.avatarUrl === undefined) return;
    this.db.update(identities).set(patch).where(eq(identities.id, identityId)).run();
  }

  /** Deletes the person. Their accounts go with them by the foreign key. */
  delete(identityId: string): void {
    this.db.delete(identities).where(eq(identities.id, identityId)).run();
  }
}

function accountIs(account: PlatformAccount) {
  return and(
    eq(identityAccounts.platform, account.platform),
    eq(identityAccounts.accountId, account.accountId),
  );
}

function holderOf(exec: Exec, account: PlatformAccount): string | null {
  return (
    exec
      .select({ identityId: identityAccounts.identityId })
      .from(identityAccounts)
      .where(accountIs(account))
      .get()?.identityId ?? null
  );
}
