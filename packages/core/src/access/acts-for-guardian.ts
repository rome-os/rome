// Access's rule that an account acts for the guardian: work the account starts
// is the guardian's. It knows accounts only by platform and id and depends on
// no other context. Vocabulary: docs/domains/access.md#acting-for-the-guardian.

import { and, eq } from "drizzle-orm";
import type { DrizzleDb, DrizzleTx, SqliteExec } from "../db/index.js";
import { accountsActingForGuardian } from "../db/schema.js";

/** An account on a platform, as Access holds the rule for it. */
export interface ActingAccount {
  platform: string;
  id: string;
}

type Db = DrizzleDb | DrizzleTx;

const rowOf = ({ platform, id }: ActingAccount) =>
  and(
    eq(accountsActingForGuardian.platform, platform),
    eq(accountsActingForGuardian.accountId, id),
  );

/** Whether `account` acts for the guardian. */
export function actsForGuardian(db: Db, account: ActingAccount): boolean {
  return (
    db
      .select({ platform: accountsActingForGuardian.platform })
      .from(accountsActingForGuardian)
      .where(rowOf(account))
      .get() !== undefined
  );
}

/** Records that `account` acts for the guardian. Saying it again changes nothing. */
export function startedActingForGuardian(db: SqliteExec, account: ActingAccount): void {
  db.insert(accountsActingForGuardian)
    .values({ platform: account.platform, accountId: account.id, createdAt: new Date() })
    .onConflictDoNothing()
    .run();
}

/** Records that `account` no longer acts for the guardian. Does nothing for an
 *  account that did not. */
export function stoppedActingForGuardian(db: SqliteExec, account: ActingAccount): void {
  db.delete(accountsActingForGuardian).where(rowOf(account)).run();
}
