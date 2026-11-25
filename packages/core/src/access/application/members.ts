// The steps Rome takes on members that need both Identity and Access: Identity
// says which person an account is, Access which role that person has.
// Vocabulary: docs/domains/access.md.

import type { DrizzleDb } from "../../db/index.js";
import {
  type Account,
  createIdentity,
  type Identity,
  type Person,
} from "../../identity/identity.js";
import { createLogger } from "../../logger.js";
import { type Access, createAccess, type Role } from "../access.js";
import { normalizeVisitorEmail } from "../visitor-email.js";

export type { Account, Person };

const log = createLogger("access-members");

/** What these steps work with. */
export interface MemberContext {
  identity: Identity;
  access: Access;
}

/** Identity and Access over `db`. */
export function memberContext(db: DrizzleDb): MemberContext {
  return { identity: createIdentity(db), access: createAccess(db) };
}

/** A person with a role, with every account of theirs. */
export interface MemberDetails {
  person: Person;
  role: Role;
  accounts: Account[];
}

/** The platform of a Rome Cloud account. */
export const ROME_CLOUD_PLATFORM = "rome-cloud";

/** The accounts a guardian's seat names: its Rome Cloud account and its
 *  email, each when the seat has one. A local password seat names none. */
export function seatAccounts(seat: {
  accountId?: string | null;
  email?: string | null;
}): Account[] {
  const accounts: Account[] = [];
  if (seat.accountId) accounts.push({ platform: ROME_CLOUD_PLATFORM, accountId: seat.accountId });
  const email = normalizeVisitorEmail(seat.email);
  if (email) accounts.push({ platform: "email", accountId: email });
  return accounts;
}

/** The role of the person `account` belongs to, or null when it belongs to
 *  nobody or its person has no role. The one question other parts ask. */
export async function roleOfAccount(
  { identity, access }: MemberContext,
  account: Account,
): Promise<Role | null> {
  const person = await identity.personOf(account);
  return person ? access.roleOf(person.id) : null;
}

/** Every person with a role, the guardian first, with their accounts. */
export async function listMembers({ identity, access }: MemberContext): Promise<MemberDetails[]> {
  const listed: MemberDetails[] = [];
  for (const { personId, role } of await access.members()) {
    const person = await identity.person(personId);
    if (!person) continue;
    listed.push({ person, role, accounts: await identity.accountsOf(personId) });
  }
  return listed;
}

/**
 * Makes the guardian's person hold `accounts`, creating the person, with
 * `name` and `avatarUrl`, when there is no guardian yet. When there is one,
 * only adds the accounts they do not hold and changes nothing else. An
 * account another person holds moves to the guardian, and the move is logged.
 * Safe to call again with the same input.
 */
export async function guardianSeatCreated(
  ctx: MemberContext,
  seat: { accounts: Account[]; name?: string; avatarUrl?: string },
): Promise<Person> {
  const { identity, access } = ctx;
  const current = (await access.members()).find((m) => m.role === "guardian");
  let guardian = current ? await identity.person(current.personId) : null;
  if (!guardian) {
    guardian = await identity.createPerson({
      name: seat.name,
      avatarUrl: seat.avatarUrl,
      accounts: [],
    });
    await access.grant(guardian.id, "guardian");
  }
  for (const account of seat.accounts) await giveGuardian(identity, guardian.id, account);
  return guardian;
}

/**
 * Moves the guardian's person from the accounts the seat named before a
 * rebind to the ones it names now: takes from the guardian each `previous`
 * account that is not `current`, then gives it `current` as
 * {@link guardianSeatCreated} does. An account the guardian holds that is not
 * in `previous`, such as one carried from People's links, stays, even when it
 * is an email other than the seat's. Safe to call again with the same input.
 */
export async function guardianSeatRebound(
  ctx: MemberContext,
  seat: { previous: Account[]; current: Account[] },
): Promise<void> {
  const { identity, access } = ctx;
  const guardianId = (await access.members()).find((m) => m.role === "guardian")?.personId;
  const kept = new Set(seat.current.map(accountKey));
  for (const account of seat.previous) {
    if (kept.has(accountKey(account))) continue;
    if (guardianId && (await identity.personOf(account))?.id === guardianId) {
      await identity.removeAccount(account);
    }
  }
  await guardianSeatCreated(ctx, { accounts: seat.current });
}

/**
 * Makes the person behind `email` a member, creating the person with the
 * email as their only account when nobody holds it. A person who already has
 * a role keeps it, so the guardian's own email answers the guardian. Throws
 * when `email` is not an email address.
 */
export async function inviteMember(
  { identity, access }: MemberContext,
  email: string,
): Promise<Person> {
  const account = emailAccount(email);
  const person =
    (await identity.personOf(account)) ?? (await identity.createPerson({ accounts: [account] }));
  await access.grant(person.id, "member");
  return person;
}

/**
 * Revokes the role of the member behind `email`, then deletes their person
 * and every account of theirs in Identity. Does nothing when nobody holds the
 * email or its person has no role. Rejects with Access's
 * `GuardianRemovalError`, changing nothing, when the email is the guardian's.
 */
export async function removeMember(
  { identity, access }: MemberContext,
  email: string,
): Promise<void> {
  const person = await identity.personOf(emailAccount(email));
  if (!person || (await access.roleOf(person.id)) === null) return;
  await access.revoke(person.id);
  await identity.deletePerson(person.id);
}

/**
 * Makes the members exactly the persons behind `emails`: invites each email
 * as {@link inviteMember} does, and removes every member who holds none of
 * them, as {@link removeMember} does. The guardian stays whatever the list says.
 */
export async function invitedEmailsSaved(
  ctx: MemberContext,
  emails: readonly string[],
): Promise<void> {
  const { identity, access } = ctx;
  const listed = new Set(emails.map((email) => emailAccount(email).accountId));
  for (const { personId, role } of await access.members()) {
    if (role !== "member") continue;
    const held = (await identity.accountsOf(personId)).some(
      (account) => account.platform === "email" && listed.has(account.accountId),
    );
    if (held) continue;
    await access.revoke(personId);
    await identity.deletePerson(personId);
  }
  for (const email of listed) await inviteMember(ctx, email);
}

/**
 * Records a sign-in by the member behind `email`: gives them `account` and,
 * when known, their avatar. Does nothing when no member holds the email, so a
 * visitor who is not a member gets no person, and nothing when the email is
 * the guardian's, since only the guardian's seat gives the guardian a Rome
 * Cloud account. Rejects with Identity's `AccountTakenError` when another person
 * holds the account.
 */
export async function memberSignedIn(
  { identity, access }: MemberContext,
  signIn: { email: string; account: Account; avatarUrl?: string | null },
): Promise<void> {
  const person = await identity.personOf(emailAccount(signIn.email));
  if (!person || (await access.roleOf(person.id)) !== "member") return;
  await identity.addAccount(person.id, signIn.account);
  if (signIn.avatarUrl) await identity.updatePerson(person.id, { avatarUrl: signIn.avatarUrl });
}

/**
 * A handler for a step that runs beside a write every reader still uses: it
 * logs the failure by name, since an error message can carry an email, and
 * resolves, because the backfill at the next startup repeats the step.
 */
export function logStepFailure(message: string): (err: unknown) => void {
  return (err) => log.warn(message, { error: err instanceof Error ? err.name : "unknown" });
}

async function giveGuardian(identity: Identity, guardianId: string, account: Account) {
  const holder = await identity.personOf(account);
  if (holder?.id === guardianId) return;
  if (holder) {
    await identity.removeAccount(account);
    log.warn("account moved to the guardian from another person", {
      platform: account.platform,
      from: holder.id,
    });
  }
  await identity.addAccount(guardianId, account);
}

function accountKey(account: Account): string {
  const id =
    account.platform === "email" ? account.accountId.trim().toLowerCase() : account.accountId;
  return `${account.platform}:${id}`;
}

function emailAccount(email: string): Account {
  const normalized = normalizeVisitorEmail(email);
  if (!normalized) throw new Error("Not an email address");
  return { platform: "email", accountId: normalized };
}
