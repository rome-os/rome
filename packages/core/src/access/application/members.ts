// The steps Rome takes on members that need both Identity and Access: Identity
// says which person an account is, Access which role that person has.
// Vocabulary: docs/domains/access.md.

import type { DrizzleDb, DrizzleTx } from "../../db/index.js";
import {
  type Account,
  createIdentity,
  type Identity,
  identityWithinTx,
  type Person,
  ROME_CLOUD_EMAIL_PLATFORM,
  type SyncIdentity,
} from "../../identity/identity.js";
import { createLogger } from "../../logger.js";
import {
  type Access,
  accessWithinTx,
  createAccess,
  type Role,
  type SyncAccess,
} from "../access.js";
import { normalizeVisitorEmail } from "../visitor-email.js";

export type { Account, Person };
export { ROME_CLOUD_EMAIL_PLATFORM };

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

/** What the `…WithinTx` steps work with: Identity and Access, synchronously. */
export interface SyncMemberContext {
  identity: SyncIdentity;
  access: SyncAccess;
}

/** Identity and Access on `tx`, so every step given it joins that transaction. */
export function memberContextWithinTx(tx: DrizzleTx): SyncMemberContext {
  return { identity: identityWithinTx(tx), access: accessWithinTx(tx) };
}

/** A person with a role, with every account of theirs. */
export interface MemberDetails {
  person: Person;
  role: Role;
  accounts: Account[];
}

/** The accounts a guardian's seat names: its email as a Rome Cloud sign-in's,
 *  when it has one. A Rome Cloud sign-in is known by the email Rome Cloud
 *  reports, so the seat's Rome Cloud id is no account. A local password seat
 *  names none. */
export function seatAccounts(seat: { email?: string | null }): Account[] {
  const email = normalizeVisitorEmail(seat.email);
  return email ? [{ platform: ROME_CLOUD_EMAIL_PLATFORM, accountId: email }] : [];
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

/** The guardian's person with every account of theirs, the one given to
 *  them last first, or null while Rome has no guardian. */
export async function guardianWithAccounts({
  identity,
  access,
}: MemberContext): Promise<{ person: Person; accounts: Account[] } | null> {
  const guardian = (await access.members()).find((m) => m.role === "guardian");
  const person = guardian && (await identity.person(guardian.personId));
  if (!person) return null;
  return { person, accounts: await identity.accountsOfNewestFirst(person.id) };
}

/** The email of every Rome Cloud sign-in account of every person with role
 *  member, sorted. The
 *  guardian's are not among them: the guardian's seat says who the guardian is. */
export async function memberEmails(ctx: MemberContext): Promise<string[]> {
  return memberEmailsWithinTx(syncOf(ctx));
}

/** {@link memberEmails}, synchronously. */
export function memberEmailsWithinTx({ identity, access }: SyncMemberContext): string[] {
  const emails: string[] = [];
  for (const { personId, role } of access.members()) {
    if (role !== "member") continue;
    for (const account of identity.accountsOf(personId)) {
      if (account.platform === ROME_CLOUD_EMAIL_PLATFORM) emails.push(account.accountId);
    }
  }
  return emails.sort();
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
  return guardianSeatCreatedWithinTx(syncOf(ctx), seat);
}

/** {@link guardianSeatCreated}, synchronously. Throws where it rejects. */
export function guardianSeatCreatedWithinTx(
  { identity, access }: SyncMemberContext,
  seat: { accounts: Account[]; name?: string; avatarUrl?: string },
): Person {
  const current = access.members().find((m) => m.role === "guardian");
  let guardian = current ? identity.person(current.personId) : null;
  if (!guardian) {
    guardian = identity.createPerson({
      name: seat.name,
      avatarUrl: seat.avatarUrl,
      accounts: [],
    });
    access.grant(guardian.id, "guardian");
  }
  for (const account of seat.accounts) giveGuardian(identity, guardian.id, account);
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
export async function inviteMember(ctx: MemberContext, email: string): Promise<Person> {
  return inviteMemberWithinTx(syncOf(ctx), email);
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
  const person = await identity.personOf(signInAccount(email));
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
  invitedEmailsSavedWithinTx(syncOf(ctx), emails);
}

/** {@link invitedEmailsSaved}, synchronously. Throws where it rejects. */
export function invitedEmailsSavedWithinTx(
  ctx: SyncMemberContext,
  emails: readonly string[],
): void {
  const { identity, access } = ctx;
  const listed = new Set(emails.map((email) => signInAccount(email).accountId));
  for (const { personId, role } of access.members()) {
    if (role !== "member") continue;
    const held = identity
      .accountsOf(personId)
      .some(
        (account) =>
          account.platform === ROME_CLOUD_EMAIL_PLATFORM && listed.has(account.accountId),
      );
    if (held) continue;
    access.revoke(personId);
    identity.deletePerson(personId);
  }
  for (const email of listed) inviteMemberWithinTx(ctx, email);
}

/**
 * Records a Rome Cloud sign-in with `email`: gives the person behind the
 * email, the guardian or a member, the avatar Rome Cloud reports, when it
 * reports one. Adds no account, since the email is the account. Does nothing
 * when the person behind the email has no role, so a visitor who is not a
 * member gets no person.
 */
export async function memberSignedIn(
  ctx: MemberContext,
  signIn: { email: string; avatarUrl?: string | null },
): Promise<void> {
  memberSignedInWithinTx(syncOf(ctx), signIn);
}

/** {@link memberSignedIn}, synchronously. */
export function memberSignedInWithinTx(
  { identity, access }: SyncMemberContext,
  signIn: { email: string; avatarUrl?: string | null },
): void {
  const person = identity.personOf(signInAccount(signIn.email));
  if (!person || access.roleOf(person.id) === null) return;
  if (signIn.avatarUrl) identity.updatePerson(person.id, { avatarUrl: signIn.avatarUrl });
}

/**
 * A handler for a step that runs beside a write every reader still uses: it
 * logs the failure by name, since an error message can carry an email, and
 * resolves, because the backfill at the next startup repeats the step.
 */
export function logStepFailure(message: string): (err: unknown) => void {
  return (err) => log.warn(message, { error: err instanceof Error ? err.name : "unknown" });
}

function inviteMemberWithinTx({ identity, access }: SyncMemberContext, email: string): Person {
  const account = signInAccount(email);
  const person = identity.personOf(account) ?? identity.createPerson({ accounts: [account] });
  access.grant(person.id, "member");
  return person;
}

/** Gives the guardian's person `account`. One another person holds moves to
 *  the guardian, and the move is logged. */
export function giveGuardian(identity: SyncIdentity, guardianId: string, account: Account) {
  const holder = identity.personOf(account);
  if (holder?.id === guardianId) return;
  if (holder) {
    identity.removeAccount(account);
    log.warn("account moved to the guardian from another person", {
      platform: account.platform,
      from: holder.id,
    });
  }
  identity.addAccount(guardianId, account);
}

function syncOf({ identity, access }: MemberContext): SyncMemberContext {
  return { identity: identity.sync, access: access.sync };
}

function accountKey(account: Account): string {
  const id =
    account.platform === "email" || account.platform === ROME_CLOUD_EMAIL_PLATFORM
      ? account.accountId.trim().toLowerCase()
      : account.accountId;
  return `${account.platform}:${id}`;
}

function signInAccount(email: string): Account {
  const normalized = normalizeVisitorEmail(email);
  if (!normalized) throw new Error("Not an email address");
  return { platform: ROME_CLOUD_EMAIL_PLATFORM, accountId: normalized };
}
