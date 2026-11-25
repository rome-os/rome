// The table behind codes that add an account to a person. Vocabulary:
// docs/domains/identity.md#account-code.

import { and, eq, isNull } from "drizzle-orm";
import type { DrizzleDb } from "../db/index.js";
import { accountCodes } from "../db/schema.js";
import { type Account, insertAccountIn, personKnown } from "./identity-repository.js";

/** Why redeeming a code wrote nothing. */
export type RedeemRefusal = "unknown" | "expired" | "used" | "unknown-person" | "taken";

/** Reads and writes `account_codes`. Each write runs in one transaction with
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
      tx.delete(accountCodes).where(eq(accountCodes.personId, personId)).run();
      tx.insert(accountCodes)
        .values({ codeHash, personId, createdAt, expiresAt, usedAt: null })
        .run();
      return null;
    });
  }

  /**
   * Gives `account` to the person the code belongs to and marks the code used
   * at `now`, in one transaction. When the person already holds the account,
   * only marks the code. When another person holds it, only marks the code
   * and returns `"taken"`: the mark is written although the account is not.
   * Returns the person's id, or why it added nothing.
   */
  redeem(
    codeHash: string,
    account: Account,
    now: Date,
  ): { personId: string } | { refused: RedeemRefusal } {
    return this.db.transaction((tx) => {
      const row = tx.select().from(accountCodes).where(eq(accountCodes.codeHash, codeHash)).get();
      if (!row) return { refused: "unknown" as const };
      if (row.usedAt) return { refused: "used" as const };
      if (row.expiresAt.getTime() <= now.getTime()) return { refused: "expired" as const };
      const refused = insertAccountIn(tx, row.personId, account, now);
      if (refused === "unknown") return { refused: "unknown-person" as const };
      tx.update(accountCodes).set({ usedAt: now }).where(eq(accountCodes.codeHash, codeHash)).run();
      if (refused === "taken") return { refused: "taken" as const };
      return { personId: row.personId };
    });
  }

  /** Marks the code used at `now` unless it is used already. Writes nothing
   *  for a hash no code has. */
  void(codeHash: string, now: Date): void {
    this.db
      .update(accountCodes)
      .set({ usedAt: now })
      .where(and(eq(accountCodes.codeHash, codeHash), isNull(accountCodes.usedAt)))
      .run();
  }
}
