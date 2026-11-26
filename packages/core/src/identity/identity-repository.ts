// The tables behind Identity: the people Rome knows and which accounts are
// theirs. Vocabulary: docs/domains/identity.md.

import { and, desc, eq, sql } from "drizzle-orm";
import type { DrizzleDb, DrizzleTx } from "../db/index.js";
import { identities, identityAccounts } from "../db/schema.js";

/** A database, or a transaction open on it. */
export type Exec = DrizzleDb | DrizzleTx;

/** An account, by its platform and the platform's own id. */
export interface Account {
  platform: string;
  accountId: string;
}

/** A person Rome knows. */
export interface Person {
  id: string;
  name: string | null;
  avatarUrl: string | null;
}

const PERSON_COLUMNS = {
  id: identities.id,
  name: identities.name,
  avatarUrl: identities.avatarUrl,
};

/** Reads and writes `identities` and `identity_accounts`. Each write that
 *  checks who holds an account runs in one transaction with its check. */
export class IdentityRepository {
  constructor(private readonly db: Exec) {}

  person(personId: string): Person | null {
    return (
      this.db.select(PERSON_COLUMNS).from(identities).where(eq(identities.id, personId)).get() ??
      null
    );
  }

  personOf(account: Account): Person | null {
    return (
      this.db
        .select(PERSON_COLUMNS)
        .from(identityAccounts)
        .innerJoin(identities, eq(identities.id, identityAccounts.identityId))
        .where(accountIs(account))
        .get() ?? null
    );
  }

  accountsOf(personId: string): Account[] {
    return this.db
      .select({ platform: identityAccounts.platform, accountId: identityAccounts.accountId })
      .from(identityAccounts)
      .where(eq(identityAccounts.identityId, personId))
      .orderBy(identityAccounts.platform, identityAccounts.accountId)
      .all();
  }

  /** The person's accounts, the one given to them last first. Accounts given
   *  in the same second keep the order they were written in. */
  accountsOfNewestFirst(personId: string): Account[] {
    return this.db
      .select({ platform: identityAccounts.platform, accountId: identityAccounts.accountId })
      .from(identityAccounts)
      .where(eq(identityAccounts.identityId, personId))
      .orderBy(desc(identityAccounts.createdAt), desc(sql`rowid`))
      .all();
  }

  /** Inserts `person` with `accounts` as theirs, unless one of the accounts
   *  belongs to someone. Returns the first such account, having written
   *  nothing, or null once both are written. */
  insert(person: Person, accounts: Account[], now: Date): Account | null {
    return this.db.transaction((tx) => {
      const taken = accounts.find((account) => holderOf(tx, account) !== null);
      if (taken) return taken;
      tx.insert(identities)
        .values({ ...person, createdAt: now })
        .run();
      for (const account of accounts) {
        tx.insert(identityAccounts)
          .values({ ...account, identityId: person.id, createdAt: now })
          .onConflictDoNothing()
          .run();
      }
      return null;
    });
  }

  /** Gives `account` to `personId` unless no such person exists or another
   *  person holds it. Returns `"unknown"` or `"taken"` for those, having
   *  written nothing, else null. */
  insertAccount(personId: string, account: Account, now: Date): AccountRefusal | null {
    return this.db.transaction((tx) => insertAccountIn(tx, personId, account, now));
  }

  deleteAccount(account: Account): void {
    this.db.delete(identityAccounts).where(accountIs(account)).run();
  }

  update(personId: string, patch: { name?: string | null; avatarUrl?: string | null }): void {
    if (patch.name === undefined && patch.avatarUrl === undefined) return;
    this.db.update(identities).set(patch).where(eq(identities.id, personId)).run();
  }

  /** Deletes the person. Their accounts go with them by the foreign key. */
  delete(personId: string): void {
    this.db.delete(identities).where(eq(identities.id, personId)).run();
  }
}

function accountIs(account: Account) {
  return and(
    eq(identityAccounts.platform, account.platform),
    eq(identityAccounts.accountId, account.accountId),
  );
}

/** Why giving an account to a person wrote nothing: no such person, or another
 *  person holds the account. */
export type AccountRefusal = "unknown" | "taken";

/** Gives `account` to `personId` inside `exec`, the one place Identity's rule
 *  that an account has one person is written. Giving it to the person who
 *  holds it already is a no-op. Returns why it wrote nothing, else null. */
export function insertAccountIn(
  exec: Exec,
  personId: string,
  account: Account,
  now: Date,
): AccountRefusal | null {
  if (!personKnown(exec, personId)) return "unknown";
  const holder = holderOf(exec, account);
  if (holder !== null) return holder === personId ? null : "taken";
  exec
    .insert(identityAccounts)
    .values({ ...account, identityId: personId, createdAt: now })
    .run();
  return null;
}

/** Whether Rome knows a person with `personId`. */
export function personKnown(exec: Exec, personId: string): boolean {
  return (
    exec.select({ id: identities.id }).from(identities).where(eq(identities.id, personId)).get() !==
    undefined
  );
}

function holderOf(exec: Exec, account: Account): string | null {
  return (
    exec
      .select({ identityId: identityAccounts.identityId })
      .from(identityAccounts)
      .where(accountIs(account))
      .get()?.identityId ?? null
  );
}
