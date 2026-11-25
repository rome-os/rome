// The steps of a code: a signed-in person gets a code of their own, and
// sending it to Rome from an account adds that account to them. Vocabulary:
// docs/domains/identity.md#account-code.

import { createHash, randomInt } from "node:crypto";
import type { DrizzleDb } from "../../db/index.js";
import {
  ACCOUNT_CODE_ALPHABET as ALPHABET,
  ACCOUNT_CODE_GROUP_LENGTH as GROUP_LENGTH,
  ACCOUNT_CODE_PREFIX as PREFIX,
  looksLikeAccountCode,
  normalizedAccountCode as normalizedCode,
} from "../../lib/account-code-shape.js";
import { AccountCodeRepository } from "../account-code-repository.js";
import {
  type Account,
  AccountTakenError,
  normalizedAccount,
  ROME_CLOUD_EMAIL_PLATFORM,
  UnknownPersonError,
} from "../identity.js";

export { looksLikeAccountCode };

/** How long a code can be redeemed after it is issued. */
export const ACCOUNT_CODE_LIFETIME_MS = 10 * 60 * 1000;

// Sign-in addresses become a person's through their seat or an invitation,
// never through a code.
const SIGN_IN_PLATFORMS: ReadonlySet<string> = new Set(["email", ROME_CLOUD_EMAIL_PLATFORM]);

/** A code sent from a sign-in address. A code adds an account on a platform a
 *  connection hears. */
export class SignInAccountCodeError extends Error {
  constructor(readonly account: Account) {
    super(`A code cannot add a sign-in address: ${account.platform}`);
    this.name = "SignInAccountCodeError";
  }
}

/** A text that is no code Rome issued, or whose code a newer one replaced. */
export class UnknownAccountCodeError extends Error {
  constructor() {
    super("No person has this code");
    this.name = "UnknownAccountCodeError";
  }
}

/** A code redeemed after its lifetime ran out. */
export class AccountCodeExpiredError extends Error {
  constructor() {
    super("The code has expired");
    this.name = "AccountCodeExpiredError";
  }
}

/** A code redeemed after it was used or voided. */
export class AccountCodeUsedError extends Error {
  constructor() {
    super("The code has already been used");
    this.name = "AccountCodeUsedError";
  }
}

/** What these steps work with. `now` is the clock every expiry is read from. */
export interface AccountCodeContext {
  codes: AccountCodeRepository;
  now: () => Date;
}

/** Codes over `db`, on the wall clock unless `now` is given. */
export function accountCodeContext(
  db: DrizzleDb,
  now: () => Date = () => new Date(),
): AccountCodeContext {
  return { codes: new AccountCodeRepository(db), now };
}

/**
 * Gives the person a code of their own and returns it, the only time the code
 * is known: Rome stores its hash. A new code replaces the person's earlier
 * one, which then redeems nothing. Rejects with {@link UnknownPersonError}
 * when Rome knows no person with `personId`.
 */
export async function accountCodeIssued(
  { codes, now }: AccountCodeContext,
  personId: string,
): Promise<{ code: string; expiresAt: Date }> {
  const code = `${PREFIX}-${randomGroup()}-${randomGroup()}`;
  const createdAt = now();
  const expiresAt = new Date(createdAt.getTime() + ACCOUNT_CODE_LIFETIME_MS);
  if (codes.replace(hashOf(code), personId, createdAt, expiresAt) === "unknown-person") {
    throw new UnknownPersonError(personId);
  }
  return { code, expiresAt };
}

/**
 * Adds `account` to the person the code belongs to and uses the code up, in
 * one transaction. When the person already holds the account, uses the code
 * up and changes nothing else. Rejects with {@link UnknownAccountCodeError},
 * {@link AccountCodeExpiredError} or {@link AccountCodeUsedError} for a text
 * that is no open code. Uses an open code up, adds nothing and rejects with
 * {@link SignInAccountCodeError} for an account on a sign-in platform, and
 * with {@link AccountTakenError} when another person holds the account: a
 * code someone tried to redeem is never usable again.
 */
export async function accountCodeRedeemed(
  { codes, now }: AccountCodeContext,
  code: string,
  account: Account,
): Promise<{ personId: string }> {
  const normal = normalizedCode(code);
  if (!looksLikeAccountCode(normal)) throw new UnknownAccountCodeError();
  if (SIGN_IN_PLATFORMS.has(account.platform)) {
    codes.void(hashOf(normal), now());
    throw new SignInAccountCodeError(account);
  }
  const result = codes.redeem(hashOf(normal), normalizedAccount(account), now());
  if (!("refused" in result)) return result;
  switch (result.refused) {
    case "unknown":
      throw new UnknownAccountCodeError();
    case "expired":
      throw new AccountCodeExpiredError();
    case "used":
      throw new AccountCodeUsedError();
    case "unknown-person":
      // Deleting a person deletes their code, so only a code whose person
      // vanished inside this transaction lands here.
      throw new UnknownAccountCodeError();
    case "taken":
      throw new AccountTakenError(account);
  }
}

/** Uses the code up without adding anything, as when it was shown where
 *  others can read it. Unknown codes are ignored. */
export async function accountCodeVoided(
  { codes, now }: AccountCodeContext,
  code: string,
): Promise<void> {
  const normal = normalizedCode(code);
  if (looksLikeAccountCode(normal)) codes.void(hashOf(normal), now());
}

function randomGroup(): string {
  let group = "";
  for (let i = 0; i < GROUP_LENGTH; i++) group += ALPHABET[randomInt(ALPHABET.length)];
  return group;
}

function hashOf(code: string): string {
  return createHash("sha256").update(code).digest("hex");
}
