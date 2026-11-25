// Identity answers which person an account is, and which accounts are a
// person's. Vocabulary: docs/domains/identity.md.

import { randomUUID } from "node:crypto";
import type { DrizzleDb } from "../db/index.js";
import { type Identity, IdentityRepository, type PlatformAccount } from "./identity-repository.js";

export type { Identity, PlatformAccount };

/** An account asked to become a person's while it belongs to another person. */
export class AccountTakenError extends Error {
  constructor(readonly account: PlatformAccount) {
    super(`Account ${account.platform}:${account.accountId} already belongs to another person`);
    this.name = "AccountTakenError";
  }
}

/**
 * The people Rome knows and the accounts that are theirs. An account belongs
 * to at most one person, and one nobody holds resolves to nobody.
 */
export class Identities {
  constructor(private readonly repository: IdentityRepository) {}

  /** Which person `account` belongs to, or null when it belongs to nobody. */
  async personOf(account: PlatformAccount): Promise<Identity | null> {
    return this.repository.personOf(normalized(account));
  }

  /** The person's accounts, by platform. Empty for a person Rome does not know. */
  async accountsOf(identityId: string): Promise<PlatformAccount[]> {
    return this.repository.accountsOf(identityId);
  }

  /** Creates a person with `accounts` as theirs. Rejects with
   *  {@link AccountTakenError}, creating nothing, when one of the accounts
   *  belongs to someone. */
  async create(input: {
    name?: string;
    avatarUrl?: string;
    accounts: PlatformAccount[];
  }): Promise<Identity> {
    const identity: Identity = {
      id: randomUUID(),
      name: input.name ?? null,
      avatarUrl: input.avatarUrl ?? null,
    };
    const taken = this.repository.insert(identity, input.accounts.map(normalized), new Date());
    if (taken) throw new AccountTakenError(taken);
    return identity;
  }

  /** Gives the person one more account. Rejects with {@link AccountTakenError}
   *  when it belongs to another person. Giving it again is a no-op. */
  async addAccount(identityId: string, account: PlatformAccount): Promise<void> {
    const normal = normalized(account);
    if (this.repository.insertAccount(identityId, normal, new Date()) !== null) {
      throw new AccountTakenError(normal);
    }
  }

  /** Makes `account` belong to nobody. */
  async removeAccount(account: PlatformAccount): Promise<void> {
    this.repository.deleteAccount(normalized(account));
  }

  /** Changes the person's name or avatar. A field left out keeps its value, and
   *  null clears it. */
  async update(
    identityId: string,
    patch: { name?: string | null; avatarUrl?: string | null },
  ): Promise<void> {
    this.repository.update(identityId, patch);
  }

  /** Deletes the person and every account of theirs, which then belong to nobody. */
  async delete(identityId: string): Promise<void> {
    this.repository.delete(identityId);
  }
}

/** Identity over `db`. */
export function createIdentities(db: DrizzleDb): Identities {
  return new Identities(new IdentityRepository(db));
}

// An email account is stored trimmed and lowercased, the way Access
// normalizes a visitor's email, so one address is one account however it was
// typed. Identity imports no other context, so the rule is repeated here.
function normalized(account: PlatformAccount): PlatformAccount {
  if (account.platform !== "email") return account;
  return { platform: "email", accountId: account.accountId.trim().toLowerCase() };
}
