// The guardian's accounts in Identity follow People's links to the guardian
// as People writes them. Vocabulary: docs/domains/access.md.

import { eq } from "drizzle-orm";
import type { DrizzleDb } from "../../db/index.js";
import { persons } from "../../db/schema.js";
import { ROME_CLOUD_ID_PLATFORM } from "./backfill-members.js";
import { giveGuardian, memberContextWithinTx } from "./members.js";

/** Which person held an account's link in People, and whether as a delegate. */
interface Holding {
  personId: string;
  delegate: boolean;
}

/** One account whose link People's write changed. */
export interface PeopleLinkChange {
  account: { platform: string; id: string };
  before: Holding | null;
  after: Holding | null;
}

/**
 * Applies one change of People's links to the guardian's person in Identity,
 * inside People's transaction, so a throw rolls People's write back too. An
 * account People now links to its guardian becomes the guardian's, moving from
 * any other person. One People linked to its guardian before the write, and no
 * longer does, stops being the guardian's. A delegate link and a Rome Cloud id
 * count as no link. Nothing changes while Rome has no guardian, or for an
 * account People's write did not take from its guardian, so an account added
 * with an account code that People never linked stays.
 */
export function peopleLinkChanged(db: DrizzleDb, change: PeopleLinkChange): void {
  if (change.account.platform === ROME_CLOUD_ID_PLATFORM) return;
  db.transaction((tx) => {
    const peopleGuardian = tx
      .select({ id: persons.id })
      .from(persons)
      .where(eq(persons.bondLevel, "guardian"))
      .limit(1)
      .get();
    if (!peopleGuardian) return;
    const guardians = (holding: Holding | null) =>
      holding?.personId === peopleGuardian.id && !holding.delegate;
    const was = guardians(change.before);
    const is = guardians(change.after);
    if (was === is) return;
    const { identity, access } = memberContextWithinTx(tx);
    const guardian = access.members().find((member) => member.role === "guardian");
    if (!guardian) return;
    const account = { platform: change.account.platform, accountId: change.account.id };
    if (is) giveGuardian(identity, guardian.personId, account);
    else if (identity.personOf(account)?.id === guardian.personId) identity.removeAccount(account);
  });
}
