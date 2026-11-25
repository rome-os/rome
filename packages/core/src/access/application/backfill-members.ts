// The members' starting data: the persons and roles the guardian's seat,
// People's links to the guardian and the invited emails an older build kept
// in the `dashboardAccess` setting say (docs/domains/access.md). It runs at
// every startup, after migrations, and a run on members that already match
// changes nothing, so it also repairs a step that failed beside a seat write
// or a sign-in. The invited emails are read only on the first run: from then
// on the members are their source, and a `settings` key records that run.

import { and, eq, sql } from "drizzle-orm";
import type { DrizzleDb } from "../../db/index.js";
import { guardianAuth, links, persons, settings, visitorProfiles } from "../../db/schema.js";
import { AccountTakenError } from "../../identity/identity.js";
import { createLogger } from "../../logger.js";
import {
  DASHBOARD_ACCESS_SETTING_KEY,
  normalizeDashboardAccessConfig,
} from "../dashboard-access-config.js";
import {
  guardianSeatCreated,
  inOneTransaction,
  invitedEmailsSaved,
  memberContext,
  memberEmails,
  memberSignedIn,
  ROME_CLOUD_PLATFORM,
  seatAccounts,
} from "./members.js";

const log = createLogger("members-backfill");

/** Set in `settings` once the invited emails have become members. */
const INVITED_EMAILS_DONE_KEY = "backfill.membersFromInvitedEmails";

/**
 * Brings the members in line with the guardian's seat and, on its first run,
 * the invited emails, in one transaction. The guardian gets the seat's Rome Cloud
 * account and email and every account People links to its guardian person,
 * as an agent's own account excepted. Its only Rome Cloud account is the
 * seat's: Rome Cloud accounts come only from a seat or a sign-in, never from
 * People, so any other one on the guardian is taken away. It takes no account
 * on another platform: Identity cannot tell an earlier seat's email from the
 * same address carried from People, so only the step beside a seat's rebind,
 * which knows the old values, takes them away. On the first run, each invited
 * email becomes a member and a member off the list is removed; later runs
 * leave who is a member alone. Each member but the guardian gets each Rome
 * Cloud account a visitor signed in with under their email. An account that
 * would land on two persons stays with or moves to the guardian, and the run
 * logs it.
 */
export async function backfillMembers(db: DrizzleDb): Promise<void> {
  await inOneTransaction(db, async () => {
    const ctx = memberContext(db);
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
      const guardian = await guardianSeatCreated(ctx, {
        accounts: [...seatAccounts(seat), ...linked],
        name: peopleGuardian?.name,
        avatarUrl: seat.avatarUrl ?? undefined,
      });
      for (const account of await ctx.identity.accountsOf(guardian.id)) {
        if (account.platform !== ROME_CLOUD_PLATFORM || account.accountId === seat.accountId) {
          continue;
        }
        await ctx.identity.removeAccount(account);
        log.warn("a Rome Cloud account the seat does not name taken from the guardian", {
          accountId: account.accountId,
        });
      }
    }

    const done = db
      .select({ key: settings.key })
      .from(settings)
      .where(eq(settings.key, INVITED_EMAILS_DONE_KEY))
      .get();
    if (!done) {
      const stored = db
        .select({ value: settings.value })
        .from(settings)
        .where(eq(settings.key, DASHBOARD_ACCESS_SETTING_KEY))
        .get();
      await invitedEmailsSaved(ctx, normalizeDashboardAccessConfig(stored?.value).cloudEmailAccess);
      db.insert(settings)
        .values({ key: INVITED_EMAILS_DONE_KEY, value: true, updatedAt: new Date() })
        .run();
    }
    const emails = await memberEmails(ctx);

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
        await memberSignedIn(ctx, { email: profile.email, account, avatarUrl: profile.avatarUrl });
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

    log.info("members brought in line with the guardian's seat", {
      guardian: seat !== undefined,
      invitedEmailsRead: !done,
      members: emails.length,
    });
  });
}
