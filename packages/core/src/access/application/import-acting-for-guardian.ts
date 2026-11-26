// The accounts acting for the guardian that People's delegate links say
// (docs/domains/access.md#acting-for-the-guardian). It runs at every startup,
// after migrations, and a second run changes nothing.

import { and, eq } from "drizzle-orm";
import type { DrizzleDb } from "../../db/index.js";
import { links, persons } from "../../db/schema.js";
import { createLogger } from "../../logger.js";
import { startedActingForGuardian } from "../acts-for-guardian.js";

const log = createLogger("acting-for-guardian-import");

/**
 * Makes each account that People links to its guardian person with a delegate
 * link act for the guardian, in one transaction. A delegate link to anyone
 * else is left out, and no account stops acting for the guardian here. When
 * the run fails, it writes nothing, and the accounts it would have added do not
 * act for the guardian until a run succeeds.
 */
export function importActingForGuardian(db: DrizzleDb): void {
  db.transaction((tx) => {
    const delegated = tx
      .select({ platform: links.platform, id: links.accountId })
      .from(links)
      .innerJoin(persons, eq(persons.id, links.personId))
      .where(and(eq(links.delegate, true), eq(persons.bondLevel, "guardian")))
      .all();
    for (const account of delegated) startedActingForGuardian(tx, account);
    log.info("accounts acting for the guardian imported", { accounts: delegated.length });
  });
}
