// The team's starting data: the persons and roles the guardian's seat, People's
// links to the guardian and the dashboard allow-list say today
// (docs/domains/access.md#team). It runs at every startup, after migrations,
// and a run on a team that already matches changes nothing, so it also repairs
// a mirror write that failed beside its seat or list write.

import { and, eq, sql } from "drizzle-orm";
import { type DrizzleDb, inTransaction } from "../db/index.js";
import { guardianAuth, links, persons, settings, visitorProfiles } from "../db/schema.js";
import { AccountTakenError } from "../identity/identities.js";
import { createLogger } from "../logger.js";
import {
  DASHBOARD_ACCESS_SETTING_KEY,
  normalizeDashboardAccessConfig,
} from "./dashboard-access-config.js";
import { createTeam, ROME_CLOUD_PLATFORM, seatAccounts } from "./team-members.js";

const log = createLogger("team-backfill");

/**
 * Brings the team in line with the guardian's seat and the dashboard
 * allow-list, in one transaction. The guardian gets the seat's Rome Cloud
 * account and email and every account People links to its guardian person,
 * as an agent's own account excepted. Each listed email becomes a teammate,
 * with each Rome Cloud account a visitor signed in with under that email. A
 * teammate off the list leaves the team. An account that would land on two
 * persons stays with or moves to the guardian, and the run logs it.
 */
export async function backfillTeam(db: DrizzleDb): Promise<void> {
  await inOneTransaction(db, async () => {
    const team = createTeam(db);
    const seat = db
      .select({
        accountId: guardianAuth.accountId,
        email: guardianAuth.email,
        avatarUrl: guardianAuth.avatarUrl,
      })
      .from(guardianAuth)
      .limit(1)
      .get();
    if (seat) {
      const peopleGuardian = db
        .select({ id: persons.id, name: persons.displayName })
        .from(persons)
        .where(eq(persons.bondLevel, "guardian"))
        .limit(1)
        .get();
      const linked = peopleGuardian
        ? db
            .select({ platform: links.platform, accountId: links.accountId })
            .from(links)
            .where(and(eq(links.personId, peopleGuardian.id), eq(links.delegate, false)))
            .orderBy(links.platform, links.accountId)
            .all()
        : [];
      await team.ensureGuardian({
        accounts: [...seatAccounts(seat), ...linked],
        name: peopleGuardian?.name,
        avatarUrl: seat.avatarUrl ?? undefined,
      });
    }

    const stored = db
      .select({ value: settings.value })
      .from(settings)
      .where(eq(settings.key, DASHBOARD_ACCESS_SETTING_KEY))
      .get();
    const emails = normalizeDashboardAccessConfig(stored?.value).cloudEmailAccess;
    await team.setTeammateEmails(emails);

    const signedIn = emails.length
      ? db
          .select({
            accountId: visitorProfiles.accountId,
            email: sql<string>`lower(trim(${visitorProfiles.email}))`,
            avatarUrl: visitorProfiles.avatarUrl,
          })
          .from(visitorProfiles)
          .orderBy(visitorProfiles.updatedAt)
          .all()
          .filter((profile) => emails.includes(profile.email))
      : [];
    for (const profile of signedIn) {
      const account = { platform: ROME_CLOUD_PLATFORM, accountId: profile.accountId };
      try {
        await team.recordSignIn({ email: profile.email, account, avatarUrl: profile.avatarUrl });
      } catch (err) {
        if (!(err instanceof AccountTakenError)) throw err;
        log.warn(
          "a listed visitor's Rome Cloud account belongs to another person and stays there",
          {
            accountId: profile.accountId,
          },
        );
      }
    }

    log.info("team brought in line with the guardian's seat and the allow-list", {
      guardian: seat !== undefined,
      teammates: emails.length,
    });
  });
}

// better-sqlite3 runs a transaction function synchronously, and the Team and
// Identity calls are async, so the transaction is opened by hand. Every call
// inside settles without waiting on I/O, so no timer or I/O callback runs
// before COMMIT or ROLLBACK, and Identity's own transactions nest as savepoints.
async function inOneTransaction(db: DrizzleDb, work: () => Promise<void>): Promise<void> {
  if (inTransaction(db)) throw new Error("The team backfill opens its own transaction");
  db.run(sql`BEGIN IMMEDIATE`);
  try {
    await work();
    db.run(sql`COMMIT`);
  } catch (err) {
    db.run(sql`ROLLBACK`);
    throw err;
  }
}
