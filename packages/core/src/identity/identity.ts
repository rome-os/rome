// Identity answers which person an account is, and which accounts are a
// person's. Vocabulary: docs/domains/identity.md.

import { randomUUID } from "node:crypto";
import type { DrizzleDb, DrizzleTx } from "../db/index.js";
import { type Person, IdentityRepository, type Account } from "./identity-repository.js";

export type { Person, Account };

/**
 * The platform of a Rome Cloud sign-in's account: the email Rome Cloud
 * reports, which Rome trusts Rome Cloud to have verified. It is not `email`,
 * the sender address an email connection hears, which anyone can write.
 */
export const ROME_CLOUD_EMAIL_PLATFORM = "rome-cloud-email";

/** An account asked to become a person's while it belongs to another person. */
export class AccountTakenError extends Error {
  constructor(readonly account: Account) {
    super(`Account ${account.platform}:${account.accountId} already belongs to another person`);
    this.name = "AccountTakenError";
  }
}

/** A person asked for by an id Rome knows no person by. */
export class UnknownPersonError extends Error {
  constructor(readonly personId: string) {
    super(`No person has id ${personId}`);
    this.name = "UnknownPersonError";
  }
}

/**
 * The people Rome knows and the accounts that are theirs. An account belongs
 * to at most one person, and one nobody holds resolves to nobody.
 */
export class Identity {
  /** The same reads and writes, answered synchronously. */
  readonly sync: SyncIdentity;

  constructor(repository: IdentityRepository) {
    this.sync = new SyncIdentity(repository);
  }

  /** The person with `personId`, or null when Rome knows no such person. */
  async person(personId: string): Promise<Person | null> {
    return this.sync.person(personId);
  }

  /** Which person `account` belongs to, or null when it belongs to nobody. */
  async personOf(account: Account): Promise<Person | null> {
    return this.sync.personOf(account);
  }

  /** The person's accounts, by platform. Empty for a person Rome does not know. */
  async accountsOf(personId: string): Promise<Account[]> {
    return this.sync.accountsOf(personId);
  }

  /** Creates a person with `accounts` as theirs. Rejects with
   *  {@link AccountTakenError}, creating nothing, when one of the accounts
   *  belongs to someone. */
  async createPerson(input: {
    name?: string;
    avatarUrl?: string;
    accounts: Account[];
  }): Promise<Person> {
    return this.sync.createPerson(input);
  }

  /** Gives the person one more account. Rejects with
   *  {@link UnknownPersonError} when no person has `personId`, and with
   *  {@link AccountTakenError} when the account belongs to another person.
   *  Giving it again is a no-op. */
  async addAccount(personId: string, account: Account): Promise<void> {
    this.sync.addAccount(personId, account);
  }

  /** Makes `account` belong to nobody. */
  async removeAccount(account: Account): Promise<void> {
    this.sync.removeAccount(account);
  }

  /** Changes the person's name or avatar. A field left out keeps its value, and
   *  null clears it. Does nothing for a person Rome does not know. */
  async updatePerson(
    personId: string,
    patch: { name?: string | null; avatarUrl?: string | null },
  ): Promise<void> {
    this.sync.updatePerson(personId, patch);
  }

  /** Deletes the person and every account of theirs, which then belong to nobody. */
  async deletePerson(personId: string): Promise<void> {
    this.sync.deletePerson(personId);
  }
}

/**
 * {@link Identity}'s reads and writes, with the same answers and rules, run
 * synchronously so a caller can put several in one synchronous transaction.
 * Each throws where Identity's rejects.
 */
export class SyncIdentity {
  constructor(private readonly repository: IdentityRepository) {}

  person(personId: string): Person | null {
    return this.repository.person(personId);
  }

  personOf(account: Account): Person | null {
    return this.repository.personOf(normalized(account));
  }

  accountsOf(personId: string): Account[] {
    return this.repository.accountsOf(personId);
  }

  createPerson(input: { name?: string; avatarUrl?: string; accounts: Account[] }): Person {
    const person: Person = {
      id: randomUUID(),
      name: input.name ?? null,
      avatarUrl: input.avatarUrl ?? null,
    };
    const taken = this.repository.insert(person, input.accounts.map(normalized), new Date());
    if (taken) throw new AccountTakenError(taken);
    return person;
  }

  addAccount(personId: string, account: Account): void {
    const normal = normalized(account);
    const refused = this.repository.insertAccount(personId, normal, new Date());
    if (refused === "unknown") throw new UnknownPersonError(personId);
    if (refused === "taken") throw new AccountTakenError(normal);
  }

  removeAccount(account: Account): void {
    this.repository.deleteAccount(normalized(account));
  }

  updatePerson(personId: string, patch: { name?: string | null; avatarUrl?: string | null }): void {
    this.repository.update(personId, patch);
  }

  deletePerson(personId: string): void {
    this.repository.delete(personId);
  }
}

/** Identity over `db`. */
export function createIdentity(db: DrizzleDb): Identity {
  return new Identity(new IdentityRepository(db));
}

/** Identity's synchronous reads and writes on `tx`, so they join its transaction. */
export function identityWithinTx(tx: DrizzleTx): SyncIdentity {
  return new SyncIdentity(new IdentityRepository(tx));
}

// An account on either email platform is stored trimmed and lowercased, the
// way Access normalizes a visitor's email, so one address is one account
// however it was typed. Identity imports no other context, so the rule is
// repeated here.
function normalized(account: Account): Account {
  if (account.platform !== "email" && account.platform !== ROME_CLOUD_EMAIL_PLATFORM) {
    return account;
  }
  return { platform: account.platform, accountId: account.accountId.trim().toLowerCase() };
}
