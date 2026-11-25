// The table behind codes that add an account to a person. Vocabulary:
// docs/domains/identity.md#claim.

import { and, eq, isNull } from "drizzle-orm";
import type { DrizzleDb } from "../db/index.js";
import { accountClaims } from "../db/schema.js";
import { type Account, insertAccountIn, personKnown } from "./identity-repository.js";

/** Why redeeming a code wrote nothing. */
export type RedeemRefusal = "unknown" | "expired" | "used" | "unknown-person" | "taken";

/** Reads and writes `account_claims`. Each write runs in one transaction with
 *  the checks it depends on. */
export class AccountCodeRepository {
  constructor(private readonly db: DrizzleDb) {}

  /** Stores a code for `personId` in place of their earlier one. Returns
   *  `"unknown-person"`, having written nothing, when Rome knows no such
   *  person, else null. */
  replace(
    codeHash: string,
    personId: string,
    createdAt: Date,
    expiresAt: Date,
  ): "unknown-person" | null {
    return this.db.transaction((tx) => {
      if (!personKnown(tx, personId)) return "unknown-person";
      tx.delete(accountClaims).where(eq(accountClaims.personId, personId)).run();
      tx.insert(accountClaims)
        .values({ codeHash, personId, createdAt, expiresAt, usedAt: null })
        .run();
      return null;
    });
  }

  /**
   * Gives `account` to the person the code belongs to and marks the code used
   * at `now`, in one transaction. When the person already holds the account,
   * only marks the code. Returns the person's id, or why it wrote nothing.
   */
  redeem(
    codeHash: string,
    account: Account,
    now: Date,
  ): { personId: string } | { refused: RedeemRefusal } {
    return this.db.transaction((tx) => {
      const row = tx.select().from(accountClaims).where(eq(accountClaims.codeHash, codeHash)).get();
      if (!row) return { refused: "unknown" as const };
      if (row.usedAt) return { refused: "used" as const };
      if (row.expiresAt.getTime() <= now.getTime()) return { refused: "expired" as const };
      const refused = insertAccountIn(tx, row.personId, account, now);
      if (refused === "unknown") return { refused: "unknown-person" as const };
      if (refused === "taken") return { refused: "taken" as const };
      tx.update(accountClaims)
        .set({ usedAt: now })
        .where(eq(accountClaims.codeHash, codeHash))
        .run();
      return { personId: row.personId };
    });
  }

  /** Marks the code used at `now` unless it is used already. Writes nothing
   *  for a hash no code has. */
  void(codeHash: string, now: Date): void {
    this.db
      .update(accountClaims)
      .set({ usedAt: now })
      .where(and(eq(accountClaims.codeHash, codeHash), isNull(accountClaims.usedAt)))
      .run();
  }
}
