// The members' starting data: the persons and roles the guardian's seat,
// People's links to the guardian and the invited emails an older build kept
// in the `dashboardAccess` setting say (docs/domains/access.md). It runs at
// every startup, after migrations, and a run on members that already match
// changes nothing, so it also repairs a step that failed beside a seat write
// or a sign-in. The invited emails are read on the first run unless a save
// of them came first: from then on the members are their source, and a
// `settings` key records the revision this build last wrote or read. They are
// read again only when an older build, after a rollback, saved them past it.

import { and, eq, sql } from "drizzle-orm";
import type { DrizzleDb, DrizzleTx } from "../../db/index.js";
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
  INVITED_EMAILS_DONE_KEY,
  normalizeDashboardAccessConfig,
  readDashboardAccessRevision,
  readInvitedEmailsDoneRevision,
} from "../dashboard-access-config.js";
import {
  guardianSeatCreatedWithinTx,
  invitedEmailsSavedWithinTx,
  memberContextWithinTx,
  memberEmailsWithinTx,
  memberSignedInWithinTx,
  ROME_CLOUD_EMAIL_PLATFORM,
  type SyncMemberContext,
  seatAccounts,
} from "./members.js";

const log = createLogger("members-backfill");

// The platform an earlier build stored Rome Cloud ids under. A Rome Cloud
// sign-in is now known by its email, so no account is kept on it.
export const ROME_CLOUD_ID_PLATFORM = "rome-cloud";

/**
 * Brings the members in line with the guardian's seat and, on its first run,
 * the invited emails, in one transaction that holds this run's writes only. A Rome Cloud sign-in is known by
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
 * them away. On the first run, unless a save of the invited emails came
 * first, each invited email becomes a member and a member off the list is
 * removed. A later run does the same only when an older build saved the
 * invited emails since this build last wrote or read them, and otherwise
 * leaves who is a member alone.
 * Each member and the guardian get the avatar a visitor last signed in with
 * under their email. An account that would land on two persons stays with or moves to the
 * guardian, and the run logs it.
 */
export async function backfillMembers(db: DrizzleDb): Promise<void> {
  // One synchronous body, so the transaction holds this run's writes only.
  db.transaction((tx) => backfillWithinTx(tx));
}

function backfillWithinTx(tx: DrizzleTx): void {
  const ctx = memberContextWithinTx(tx);
  const cloudIds = tx
    .select({ platform: identityAccounts.platform, accountId: identityAccounts.accountId })
    .from(identityAccounts)
    .where(eq(identityAccounts.platform, ROME_CLOUD_ID_PLATFORM))
    .all();
  for (const account of cloudIds) ctx.identity.removeAccount(account);
  if (cloudIds.length > 0) {
    log.info("Rome Cloud ids taken from Identity", { accounts: cloudIds.length });
  }
  moveMemberEmailsToSignIns(ctx);
  const seat = tx
    .select({
      email: guardianAuth.email,
      avatarUrl: guardianAuth.avatarUrl,
    })
    .from(guardianAuth)
    .limit(1)
    .get();
  if (seat) {
    const peopleGuardian = tx
      .select({ id: persons.id, name: persons.displayName })
      .from(persons)
      .where(eq(persons.bondLevel, "guardian"))
      .limit(1)
      .get();
    const linked = peopleGuardian
      ? tx
          .select({ platform: links.platform, accountId: links.accountId })
          .from(links)
          .where(and(eq(links.personId, peopleGuardian.id), eq(links.delegate, false)))
          .orderBy(links.platform, links.accountId)
          .all()
          .filter((link) => link.platform !== ROME_CLOUD_ID_PLATFORM)
      : [];
    const guardian = guardianSeatCreatedWithinTx(ctx, {
      accounts: [...seatAccounts(seat), ...linked],
      name: peopleGuardian?.name,
      avatarUrl: seat.avatarUrl ?? undefined,
    });
    const [seatSignIn] = seatAccounts(seat);
    const seatAddress = seatSignIn && { platform: "email", accountId: seatSignIn.accountId };
    const linkedAddress = linked.some(
      (link) =>
        link.platform === "email" && link.accountId.trim().toLowerCase() === seatAddress?.accountId,
    );
    if (seatAddress && !linkedAddress && ctx.identity.personOf(seatAddress)?.id === guardian.id) {
      ctx.identity.removeAccount(seatAddress);
    }
  }

  const done = settingValue(tx, INVITED_EMAILS_DONE_KEY);
  const stored = settingValue(tx, DASHBOARD_ACCESS_SETTING_KEY);
  const storedRevision = readDashboardAccessRevision(stored?.value);
  const readList = !done || storedRevision > readInvitedEmailsDoneRevision(done.value);
  if (readList) {
    invitedEmailsSavedWithinTx(ctx, normalizeDashboardAccessConfig(stored?.value).cloudEmailAccess);
    const updatedAt = new Date();
    tx.insert(settings)
      .values({ key: INVITED_EMAILS_DONE_KEY, value: storedRevision, updatedAt })
      .onConflictDoUpdate({ target: settings.key, set: { value: storedRevision, updatedAt } })
      .run();
  }
  const emails = memberEmailsWithinTx(ctx);
  // The guardian's email is a sign-in too: same email, same person.
  const signInEmails = [...emails, ...(seat ? seatAccounts(seat) : []).map((a) => a.accountId)];

  const signedIn = signInEmails.length
    ? tx
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
    memberSignedInWithinTx(ctx, { email: profile.email, avatarUrl: profile.avatarUrl });
  }

  log.info("members brought in line with the guardian's seat", {
    guardian: seat !== undefined,
    invitedEmailsRead: readList,
    members: emails.length,
  });
}

function settingValue(tx: DrizzleTx, key: string): { value: unknown } | undefined {
  return tx.select({ value: settings.value }).from(settings).where(eq(settings.key, key)).get();
}

// Each `email` account of a person with role member came from an invitation,
// so it becomes the same address on the sign-in platform. One whose sign-in
// account another person holds is only taken away, and the run logs it.
function moveMemberEmailsToSignIns(ctx: SyncMemberContext): void {
  for (const { personId, role } of ctx.access.members()) {
    if (role !== "member") continue;
    for (const account of ctx.identity.accountsOf(personId)) {
      if (account.platform !== "email") continue;
      ctx.identity.removeAccount(account);
      const signIn = { platform: ROME_CLOUD_EMAIL_PLATFORM, accountId: account.accountId };
      const holder = ctx.identity.personOf(signIn);
      if (!holder) ctx.identity.addAccount(personId, signIn);
      else if (holder.id !== personId) log.warn("a member's email is another person's sign-in");
    }
  }
}
