// The table behind claims on accounts. Vocabulary: docs/domains/identity.md#claim.

import { and, eq } from "drizzle-orm";
import type { DrizzleDb } from "../db/index.js";
import { accountClaims } from "../db/schema.js";
import { type Account, holderOf, insertAccountIn } from "./identity-repository.js";

/** A claim as stored, known by the hash of its token. */
export interface StoredClaim {
  account: Account;
  label: string | null;
  expiresAt: Date;
  confirmedAt: Date | null;
}

/** Why confirming a claim wrote nothing. A taken account names itself. */
export type ConfirmRefusal =
  | { refused: "unknown" | "expired" | "used" | "unknown-person" }
  | { refused: "taken"; account: Account };

/** Reads and writes `account_claims`. Each write that checks who holds the
 *  account runs in one transaction with its check. */
export class AccountClaimRepository {
  constructor(private readonly db: DrizzleDb) {}

  /** Stores a claim on `account` in place of any earlier claim on it, unless
   *  a person holds the account. Returns `"taken"` then, having written
   *  nothing, else null. */
  replace(
    tokenHash: string,
    account: Account,
    label: string | null,
    createdAt: Date,
    expiresAt: Date,
  ): "taken" | null {
    return this.db.transaction((tx) => {
      if (holderOf(tx, account) !== null) return "taken";
      tx.delete(accountClaims).where(claimIsOn(account)).run();
      tx.insert(accountClaims)
        .values({ tokenHash, ...account, label, createdAt, expiresAt, confirmedAt: null })
        .run();
      return null;
    });
  }

  byTokenHash(tokenHash: string): StoredClaim | null {
    const row = this.db
      .select()
      .from(accountClaims)
      .where(eq(accountClaims.tokenHash, tokenHash))
      .get();
    if (!row) return null;
    return {
      account: { platform: row.platform, accountId: row.accountId },
      label: row.label,
      expiresAt: row.expiresAt,
      confirmedAt: row.confirmedAt,
    };
  }

  /**
   * Gives the claim's account to `personId` and marks the claim confirmed at
   * `now`, in one transaction. When the person already holds the account,
   * only marks the claim. Returns the account and its label, or why it wrote
   * nothing.
   */
  confirm(
    tokenHash: string,
    personId: string,
    now: Date,
  ): { account: Account; label: string | null } | ConfirmRefusal {
    return this.db.transaction((tx) => {
      const row = tx
        .select()
        .from(accountClaims)
        .where(eq(accountClaims.tokenHash, tokenHash))
        .get();
      if (!row) return { refused: "unknown" as const };
      if (row.confirmedAt) return { refused: "used" as const };
      if (row.expiresAt.getTime() <= now.getTime()) return { refused: "expired" as const };
      const account = { platform: row.platform, accountId: row.accountId };
      const refused = insertAccountIn(tx, personId, account, now);
      if (refused === "unknown") return { refused: "unknown-person" as const };
      if (refused === "taken") return { refused: "taken" as const, account };
      tx.update(accountClaims)
        .set({ confirmedAt: now })
        .where(eq(accountClaims.tokenHash, tokenHash))
        .run();
      return { account, label: row.label };
    });
  }
}

function claimIsOn(account: Account) {
  return and(
    eq(accountClaims.platform, account.platform),
    eq(accountClaims.accountId, account.accountId),
  );
}
