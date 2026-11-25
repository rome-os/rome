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
  ROME_CLOUD_EMAIL_PLATFORM,
  UnknownPersonError,
} from "../identity.js";

/** How long a claim can be confirmed after it starts. */
export const CLAIM_LIFETIME_MS = 15 * 60 * 1000;

/** The longest label a claim keeps. A longer one is cut to this length. */
export const CLAIM_LABEL_MAX_LENGTH = 120;

// Sign-in addresses become a person's through their seat or an invitation,
// never through a claim.
const SIGN_IN_PLATFORMS: ReadonlySet<string> = new Set(["email", ROME_CLOUD_EMAIL_PLATFORM]);

/** A claim started on a sign-in address. A claim is for an account on a
 *  platform a connection hears. */
export class SignInAccountClaimError extends Error {
  constructor(readonly account: Account) {
    super(`A sign-in address cannot be claimed: ${account.platform}`);
    this.name = "SignInAccountClaimError";
  }
}

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
 * the earlier claim, whose token then answers nothing.
 *
 * `label` is the account's name as the platform shows it, taken from the
 * message that started the claim. It is kept trimmed and cut to
 * {@link CLAIM_LABEL_MAX_LENGTH}, and only shown to the person confirming:
 * Identity neither looks it up nor trusts it.
 *
 * Rejects, starting nothing, with {@link SignInAccountClaimError} for an
 * account on a sign-in platform and {@link AccountTakenError} when a person
 * holds the account.
 */
export async function accountClaimStarted(
  { claims, now }: ClaimContext,
  account: Account,
  options: { label?: string } = {},
): Promise<{ token: string; expiresAt: Date }> {
  if (SIGN_IN_PLATFORMS.has(account.platform)) throw new SignInAccountClaimError(account);
  const normal = normalizedAccount(account);
  const label = keptLabel(options.label);
  const token = randomBytes(32).toString("base64url");
  const createdAt = now();
  const expiresAt = new Date(createdAt.getTime() + CLAIM_LIFETIME_MS);
  if (claims.replace(hashOf(token), normal, label, createdAt, expiresAt) === "taken") {
    throw new AccountTakenError(normal);
  }
  return { token, expiresAt };
}

/** The account a claim is for and its label, so a person can be asked to
 *  confirm it. Null when the token is unknown, or its claim has expired or
 *  been confirmed. Changes nothing. */
export async function accountClaimOf(
  { claims, now }: ClaimContext,
  token: string,
): Promise<{ account: Account; label: string | null; expiresAt: Date } | null> {
  const claim = claims.byTokenHash(hashOf(token));
  if (!claim || claim.confirmedAt || claim.expiresAt.getTime() <= now().getTime()) return null;
  return { account: claim.account, label: claim.label, expiresAt: claim.expiresAt };
}

/**
 * Makes the claim's account the person's and uses the claim up, in one
 * transaction, and returns the account with the claim's label. Confirming for
 * the person who already holds the account uses the claim up and changes
 * nothing else. Rejects, changing nothing, with
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
): Promise<{ account: Account; label: string | null }> {
  const result = claims.confirm(hashOf(token), personId, now());
  if (!("refused" in result)) return result;
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

// Counts characters, not UTF-16 units, so a cut never splits one in half.
function keptLabel(label: string | undefined): string | null {
  const characters = Array.from(label?.trim() ?? "");
  return characters.slice(0, CLAIM_LABEL_MAX_LENGTH).join("").trim() || null;
}

function hashOf(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}
