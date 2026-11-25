// The members' starting data: the persons and roles the guardian's seat,
// People's links to the guardian and the invited emails an older build kept
// in the `dashboardAccess` setting say (docs/domains/access.md). It runs at
// every startup, after migrations, and a run on members that already match
// changes nothing, so it also repairs a step that failed beside a seat write
// or a sign-in. The invited emails are read only on the first run: from then
// on the members are their source, and a `settings` key records that run.

import { and, eq, sql } from "drizzle-orm";
import type { DrizzleDb } from "../../db/index.js";
import {
  guardianAuth,
  identityAccounts,
  links,
  persons,
  settings,
  visitorProfiles,
} from "../../db/schema.js";
import { createLogger } from "../../logger.js";
import {
  DASHBOARD_ACCESS_SETTING_KEY,
  normalizeDashboardAccessConfig,
} from "../dashboard-access-config.js";
import {
  guardianSeatCreated,
  inOneTransaction,
  invitedEmailsSaved,
  type MemberContext,
  memberContext,
  memberEmails,
  memberSignedIn,
  ROME_CLOUD_EMAIL_PLATFORM,
  seatAccounts,
} from "./members.js";

const log = createLogger("members-backfill");

/** Set in `settings` once the invited emails have become members. */
const INVITED_EMAILS_DONE_KEY = "backfill.membersFromInvitedEmails";

// The platform an earlier build stored Rome Cloud ids under. A Rome Cloud
// sign-in is now known by its email, so no account is kept on it.
const ROME_CLOUD_ID_PLATFORM = "rome-cloud";

/**
 * Brings the members in line with the guardian's seat and, on its first run,
 * the invited emails, in one transaction. A Rome Cloud sign-in is known by
 * its email on the `rome-cloud-email` platform, so the accounts an earlier
 * build stored move there: every Rome Cloud id stored as an account is taken
 * away, from any person, and each `email` account of a member, which only an
 * invitation gave, becomes the same address on `rome-cloud-email`. The
 * guardian gets the seat's email as a sign-in's and every account People
 * links to its guardian person, as an agent's own account excepted, and loses
 * the seat's address as an `email` account unless People links it too, as an
 * email connection's address. It takes no other email away: Identity cannot
 * tell an earlier seat's email from the same address carried from People, so
 * only the step beside a seat's rebind, which knows the old values, takes
 * them away. On the first run, each invited email becomes a member and a
 * member off the list is removed; later runs leave who is a member alone.
 * Each member and the guardian get the avatar a visitor last signed in with
 * under their email. An account that would land on two persons stays with or moves to the
 * guardian, and the run logs it.
 */
export async function backfillMembers(db: DrizzleDb): Promise<void> {
  await inOneTransaction(db, async () => {
    const ctx = memberContext(db);
    const cloudIds = db
      .select({ platform: identityAccounts.platform, accountId: identityAccounts.accountId })
      .from(identityAccounts)
      .where(eq(identityAccounts.platform, ROME_CLOUD_ID_PLATFORM))
      .all();
    for (const account of cloudIds) await ctx.identity.removeAccount(account);
    if (cloudIds.length > 0) {
      log.info("Rome Cloud ids taken from Identity", { accounts: cloudIds.length });
    }
    await moveMemberEmailsToSignIns(ctx);
    const seat = db
      .select({
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
            .filter((link) => link.platform !== ROME_CLOUD_ID_PLATFORM)
        : [];
      const guardian = await guardianSeatCreated(ctx, {
        accounts: [...seatAccounts(seat), ...linked],
        name: peopleGuardian?.name,
        avatarUrl: seat.avatarUrl ?? undefined,
      });
      const [seatSignIn] = seatAccounts(seat);
      const seatAddress = seatSignIn && { platform: "email", accountId: seatSignIn.accountId };
      const linkedAddress = linked.some(
        (link) =>
          link.platform === "email" &&
          link.accountId.trim().toLowerCase() === seatAddress?.accountId,
      );
      if (
        seatAddress &&
        !linkedAddress &&
        (await ctx.identity.personOf(seatAddress))?.id === guardian.id
      ) {
        await ctx.identity.removeAccount(seatAddress);
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
    // The guardian's email is a sign-in too: same email, same person.
    const signInEmails = [...emails, ...(seat ? seatAccounts(seat) : []).map((a) => a.accountId)];

    const signedIn = signInEmails.length
      ? db
          .select({
            email: sql<string>`lower(trim(${visitorProfiles.email}))`,
            avatarUrl: visitorProfiles.avatarUrl,
          })
          .from(visitorProfiles)
          .orderBy(visitorProfiles.updatedAt)
          .all()
          .filter((profile) => signInEmails.includes(profile.email))
      : [];
    for (const profile of signedIn) {
      await memberSignedIn(ctx, { email: profile.email, avatarUrl: profile.avatarUrl });
    }

    log.info("members brought in line with the guardian's seat", {
      guardian: seat !== undefined,
      invitedEmailsRead: !done,
      members: emails.length,
    });
  });
}

// Each `email` account of a person with role member came from an invitation,
// so it becomes the same address on the sign-in platform. One whose sign-in
// account another person holds is only taken away, and the run logs it.
async function moveMemberEmailsToSignIns(ctx: MemberContext): Promise<void> {
  for (const { personId, role } of await ctx.access.members()) {
    if (role !== "member") continue;
    for (const account of await ctx.identity.accountsOf(personId)) {
      if (account.platform !== "email") continue;
      await ctx.identity.removeAccount(account);
      const signIn = { platform: ROME_CLOUD_EMAIL_PLATFORM, accountId: account.accountId };
      const holder = await ctx.identity.personOf(signIn);
      if (!holder) await ctx.identity.addAccount(personId, signIn);
      else if (holder.id !== personId) log.warn("a member's email is another person's sign-in");
    }
  }
}
