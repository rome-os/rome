// The steps of a claim: Rome starts one for an account nobody holds and sends
// its sign-in link, and a signed-in person confirms it to make the account
// theirs. Vocabulary: docs/domains/identity.md#claim.

import { createHash, randomBytes } from "node:crypto";
import type { DrizzleDb } from "../../db/index.js";
import { AccountClaimRepository } from "../account-claim-repository.js";
import {
  type Account,
  AccountTakenError,
  normalizedAccount,
  UnknownPersonError,
} from "../identity.js";

/** How long a claim can be confirmed after it starts. */
export const CLAIM_LIFETIME_MS = 15 * 60 * 1000;

/** A token no claim was started with, or whose claim another start replaced. */
export class UnknownClaimError extends Error {
  constructor() {
    super("No claim has this token");
    this.name = "UnknownClaimError";
  }
}

/** A claim confirmed after its lifetime ran out. */
export class ClaimExpiredError extends Error {
  constructor() {
    super("The claim has expired");
    this.name = "ClaimExpiredError";
  }
}

/** A claim confirmed a second time. */
export class ClaimUsedError extends Error {
  constructor() {
    super("The claim has already been confirmed");
    this.name = "ClaimUsedError";
  }
}

/** What these steps work with. `now` is the clock every expiry is read from. */
export interface ClaimContext {
  claims: AccountClaimRepository;
  now: () => Date;
}

/** Claims over `db`, on the wall clock unless `now` is given. */
export function claimContext(db: DrizzleDb, now: () => Date = () => new Date()): ClaimContext {
  return { claims: new AccountClaimRepository(db), now };
}

/**
 * Starts a claim on `account` and returns its token, the only time the token
 * is known: Rome stores its hash. Starting again for the same account replaces
 * the earlier claim, whose token then answers nothing. Rejects with
 * {@link AccountTakenError}, starting nothing, when a person holds the account.
 */
export async function accountClaimStarted(
  { claims, now }: ClaimContext,
  account: Account,
): Promise<{ token: string; expiresAt: Date }> {
  const normal = normalizedAccount(account);
  const token = randomBytes(32).toString("base64url");
  const createdAt = now();
  const expiresAt = new Date(createdAt.getTime() + CLAIM_LIFETIME_MS);
  if (claims.replace(hashOf(token), normal, createdAt, expiresAt) === "taken") {
    throw new AccountTakenError(normal);
  }
  return { token, expiresAt };
}

/** The account a claim is for, so a person can be asked to confirm it. Null
 *  when the token is unknown, or its claim has expired or been confirmed.
 *  Changes nothing. */
export async function accountClaimOf(
  { claims, now }: ClaimContext,
  token: string,
): Promise<{ account: Account; expiresAt: Date } | null> {
  const claim = claims.byTokenHash(hashOf(token));
  if (!claim || claim.confirmedAt || claim.expiresAt.getTime() <= now().getTime()) return null;
  return { account: claim.account, expiresAt: claim.expiresAt };
}

/**
 * Makes the claim's account the person's and uses the claim up, in one
 * transaction. Confirming for the person who already holds the account uses
 * the claim up and changes nothing else. Rejects, changing nothing, with
 * {@link UnknownClaimError}, {@link ClaimExpiredError} or
 * {@link ClaimUsedError} for a token no open claim has,
 * {@link UnknownPersonError} when no person has `personId`, and
 * {@link AccountTakenError} when another person took the account since the
 * claim started.
 */
export async function accountClaimConfirmed(
  { claims, now }: ClaimContext,
  token: string,
  personId: string,
): Promise<Account> {
  const result = claims.confirm(hashOf(token), personId, now());
  if (!("refused" in result)) return result.account;
  switch (result.refused) {
    case "unknown":
      throw new UnknownClaimError();
    case "expired":
      throw new ClaimExpiredError();
    case "used":
      throw new ClaimUsedError();
    case "unknown-person":
      throw new UnknownPersonError(personId);
    case "taken":
      throw new AccountTakenError(result.account);
  }
}

function hashOf(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}
