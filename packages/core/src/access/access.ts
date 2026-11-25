// Access's own service: who is on the team and in which role, stored beside
// the dashboard allow-list and the guardian's seat while every reader still
// uses those. Vocabulary: docs/domains/access.md. Who a person is comes from
// Identity.

import { eq, sql } from "drizzle-orm";
import type { DrizzleDb } from "../db/index.js";
import { identities as identityRows, teamMembers } from "../db/schema.js";
import {
  createIdentities,
  type Identities,
  type Identity,
  type PlatformAccount,
} from "../identity/identities.js";
import { createLogger } from "../logger.js";
import { normalizeVisitorEmail } from "./visitor-email.js";

export type { Identity, PlatformAccount };

/** What a member is on the team. */
export type Role = "guardian" | "teammate";

/** The platform of a Rome Cloud account. */
export const ROME_CLOUD_PLATFORM = "rome-cloud";

/** The accounts a guardian's seat names: its Rome Cloud account and its
 *  email, each when the seat has one. A local password seat names none. */
export function seatAccounts(seat: {
  accountId?: string | null;
  email?: string | null;
}): PlatformAccount[] {
  const accounts: PlatformAccount[] = [];
  if (seat.accountId) accounts.push({ platform: ROME_CLOUD_PLATFORM, accountId: seat.accountId });
  const email = normalizeVisitorEmail(seat.email);
  if (email) accounts.push({ platform: "email", accountId: email });
  return accounts;
}

/** A member: a person on the team, with their role and every account of theirs. */
export interface Member {
  identity: Identity;
  role: Role;
  accounts: PlatformAccount[];
}

/** Asked to take the guardian off the team. The guardian is never removed. */
export class GuardianRemovalError extends Error {
  constructor() {
    super("The guardian cannot be removed from the team");
    this.name = "GuardianRemovalError";
  }
}

/** Asked to record an account on a person who is not on the team. */
export class NotOnTeamError extends Error {
  constructor(readonly identityId: string) {
    super(`Person ${identityId} is not on the team`);
    this.name = "NotOnTeamError";
  }
}

const log = createLogger("team");

/**
 * Answers who is on the team and in which role: exactly one guardian, and any
 * number of teammates. Sessions and app permissions are separate modules of
 * the Access context, not part of this class. Removing a teammate deletes the person and their
 * accounts in Identity. Other parts ask {@link Access.roleOf} with an account
 * and never ask Identity for the team themselves.
 */
export class Access {
  constructor(
    private readonly db: DrizzleDb,
    private readonly identities: Identities,
  ) {}

  /** The role on the team of the person `account` belongs to, or null when it
   *  belongs to nobody or its person is not on the team. */
  async roleOf(account: PlatformAccount): Promise<Role | null> {
    const person = await this.identities.personOf(account);
    return person ? this.roleOfPerson(person.id) : null;
  }

  /** The person's role on the team, or null when they are not on it. */
  async roleOfPerson(identityId: string): Promise<Role | null> {
    return (
      this.db
        .select({ role: teamMembers.role })
        .from(teamMembers)
        .where(eq(teamMembers.identityId, identityId))
        .get()?.role ?? null
    );
  }

  /** Every person on the team, the guardian first, then teammates in the
   *  order they joined. */
  async members(): Promise<Member[]> {
    const members: Member[] = [];
    for (const { role, ...identity } of this.memberRows()) {
      members.push({ identity, role, accounts: await this.identities.accountsOf(identity.id) });
    }
    return members;
  }

  /**
   * Makes sure the guardian's person and team row exist and holds `accounts`.
   * Creates the person, with `name` and `avatarUrl`, when there is no guardian.
   * When there is one, only adds the accounts they do not hold yet and changes
   * nothing else. An account another person holds moves to the guardian, and
   * the move is logged. Safe to call again with the same input.
   */
  async ensureGuardian(input: {
    accounts: PlatformAccount[];
    name?: string;
    avatarUrl?: string;
  }): Promise<Identity> {
    let guardian = await this.guardian();
    if (!guardian) {
      guardian = await this.identities.create({
        name: input.name,
        avatarUrl: input.avatarUrl,
        accounts: [],
      });
      this.insertMember(guardian.id, "guardian");
    }
    for (const account of input.accounts) await this.giveGuardian(guardian.id, account);
    return guardian;
  }

  /**
   * Puts the person behind `email` on the team as a teammate, creating the
   * person with the email as their only account when nobody holds it. A
   * person already on the team keeps their role, so the guardian's own email
   * answers the guardian. Throws when `email` is not an email address.
   */
  async addTeammateByEmail(email: string): Promise<Identity> {
    const account = emailAccount(email);
    const holder = await this.identities.personOf(account);
    if (holder) {
      if ((await this.roleOfPerson(holder.id)) === null) this.insertMember(holder.id, "teammate");
      return holder;
    }
    const person = await this.identities.create({ accounts: [account] });
    this.insertMember(person.id, "teammate");
    return person;
  }

  /**
   * Takes the person behind `email` off the team and deletes the person and
   * every account of theirs. Does nothing when nobody holds the email or its
   * person is not on the team. Rejects with {@link GuardianRemovalError},
   * changing nothing, when the email is the guardian's.
   */
  async removeTeammateByEmail(email: string): Promise<void> {
    const holder = await this.identities.personOf(emailAccount(email));
    if (!holder) return;
    const role = await this.roleOfPerson(holder.id);
    if (role === "guardian") throw new GuardianRemovalError();
    if (role === "teammate") await this.identities.delete(holder.id);
  }

  /**
   * Makes the teammates exactly the persons behind `emails`: adds each email
   * as {@link addTeammateByEmail} does, and removes every teammate who holds
   * none of them. The guardian stays whatever the list says.
   */
  async setTeammateEmails(emails: readonly string[]): Promise<void> {
    const listed = new Set(emails.map((email) => emailAccount(email).accountId));
    for (const member of await this.members()) {
      if (member.role !== "teammate") continue;
      const held = member.accounts.some(
        (account) => account.platform === "email" && listed.has(account.accountId),
      );
      if (!held) await this.identities.delete(member.identity.id);
    }
    for (const email of listed) await this.addTeammateByEmail(email);
  }

  /**
   * Gives a person on the team one more account, as a sign-in does. Rejects
   * with {@link NotOnTeamError} for a person off the team, and with Identity's
   * `AccountTakenError` when another person holds the account.
   */
  async recordAccount(identityId: string, account: PlatformAccount): Promise<void> {
    if ((await this.roleOfPerson(identityId)) === null) throw new NotOnTeamError(identityId);
    await this.identities.addAccount(identityId, account);
  }

  /**
   * Records a sign-in by the person on the team behind `email`: gives them
   * `account` and, when known, their avatar. Does nothing when nobody on the
   * team holds the email, so a visitor off the team gets no person.
   */
  async recordSignIn(input: {
    email: string;
    account: PlatformAccount;
    avatarUrl?: string | null;
  }): Promise<void> {
    const person = await this.identities.personOf(emailAccount(input.email));
    if (!person || (await this.roleOfPerson(person.id)) === null) return;
    await this.recordAccount(person.id, input.account);
    if (input.avatarUrl) await this.identities.update(person.id, { avatarUrl: input.avatarUrl });
  }

  private async guardian(): Promise<Identity | null> {
    const row = this.memberRows().find((member) => member.role === "guardian");
    if (!row) return null;
    const { role: _role, ...identity } = row;
    return identity;
  }

  // Read beside the person's row rather than through Identity, which finds a
  // person only by an account, and a team member may hold none.
  private memberRows(): Array<Identity & { role: Role }> {
    return this.db
      .select({
        id: identityRows.id,
        name: identityRows.name,
        avatarUrl: identityRows.avatarUrl,
        role: teamMembers.role,
      })
      .from(teamMembers)
      .innerJoin(identityRows, eq(identityRows.id, teamMembers.identityId))
      .orderBy(
        sql`${teamMembers.role} = 'guardian' DESC`,
        teamMembers.createdAt,
        sql`"team_members".rowid`,
      )
      .all();
  }

  private async giveGuardian(guardianId: string, account: PlatformAccount): Promise<void> {
    const holder = await this.identities.personOf(account);
    if (holder?.id === guardianId) return;
    if (holder) {
      await this.identities.removeAccount(account);
      log.warn("account moved to the guardian from another person", {
        platform: account.platform,
        from: holder.id,
      });
    }
    await this.identities.addAccount(guardianId, account);
  }

  private insertMember(identityId: string, role: Role): void {
    this.db.insert(teamMembers).values({ identityId, role, createdAt: new Date() }).run();
  }
}

/** Access over `db`. */
export function createAccess(db: DrizzleDb): Access {
  return new Access(db, createIdentities(db));
}

/**
 * Puts the guardian of a seat just created on the team, as
 * {@link Access.ensureGuardian} does with the seat's accounts. Never rejects: the
 * seat is what every reader uses, so a failure is logged, and the team backfill
 * at the next startup puts the guardian on the team.
 */
export async function putSeatOnTeam(
  db: DrizzleDb,
  seat: {
    accountId?: string | null;
    email?: string | null;
    name?: string;
    avatarUrl?: string | null;
  },
): Promise<void> {
  try {
    await createAccess(db).ensureGuardian({
      accounts: seatAccounts(seat),
      name: seat.name,
      avatarUrl: seat.avatarUrl ?? undefined,
    });
  } catch (err) {
    log.warn("guardian not put on the team", { error: errorName(err) });
  }
}

/**
 * Records a visitor's Rome Cloud sign-in on the team, as
 * {@link Access.recordSignIn} does. Never rejects: a failure is logged, and the
 * team backfill at the next startup records the account from the visitor's
 * profile.
 */
export async function recordSignInOnTeam(
  db: DrizzleDb,
  visitor: { email: string; accountId: string; avatarUrl: string | null },
): Promise<void> {
  try {
    await createAccess(db).recordSignIn({
      email: visitor.email,
      account: { platform: ROME_CLOUD_PLATFORM, accountId: visitor.accountId },
      avatarUrl: visitor.avatarUrl,
    });
  } catch (err) {
    log.warn("visitor sign-in not recorded on the team", { error: errorName(err) });
  }
}

// The name only: an error message can carry an email, and these logs carry none.
function errorName(err: unknown): string {
  return err instanceof Error ? err.name : "unknown";
}

function emailAccount(email: string): PlatformAccount {
  const normalized = normalizeVisitorEmail(email);
  if (!normalized) throw new Error("Not an email address");
  return { platform: "email", accountId: normalized };
}
