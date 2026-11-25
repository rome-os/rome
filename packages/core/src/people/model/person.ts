import type { Account, BondLevel } from "@rome-os/app-runtime";

/**
 * The account a link names, the way Chats names it: the platform and the
 * platform's own id for it (docs/domains/chats.md#account). One account is one
 * link whichever of Rome's accounts met it.
 */
export type Link = Account;

/**
 * One of a person's links. `delegate` is set on a
 * [delegate link](docs/domains/people.md#delegate-link): the account is an
 * agent's, acting for this person. Absent on the person's own accounts.
 */
export interface PersonLink extends Link {
  delegate?: true;
}

/** Someone the guardian knows, with every account linked to them. */
export interface Person {
  id: string;
  displayName: string;
  bondLevel: BondLevel;
  profilePath: string | null;
  createdAt: Date;
  links: PersonLink[];
}

/** A person as {@link PeopleRepository.create} takes them. */
export interface NewPerson {
  displayName: string;
  bondLevel: BondLevel;
  profilePath?: string;
}

/** The fields of a person that change in place. */
export type PersonChanges = Partial<{
  displayName: string;
  bondLevel: BondLevel;
  profilePath: string | null;
}>;

/** A dismissed account. */
export type Dismissal = Link;

/** An account a person already holds, and the person holding it. */
export interface AccountHolder extends Link {
  personId: string;
  personName: string;
}

/**
 * Thrown when a create would take an account a real person already holds.
 *
 * Carries the holder rather than only reporting that there is one: every
 * caller has to name them, because the guardian decides whether to move the
 * account and cannot decide without knowing whose it is.
 *
 * A dismissed account has no holder. A dismissal names no person, so naming
 * its sender takes the account with nothing to refuse.
 */
export class AccountHeldError extends Error {
  constructor(readonly holder: AccountHolder) {
    super(`Account ${holder.platform}:${holder.id} already belongs to person "${holder.personId}"`);
    this.name = "AccountHeldError";
  }
}

/** What a link, move or dismiss did: took the account, or refused it and named
 *  whoever holds it — null where nobody does, which is what a stale move runs
 *  into.
 *
 *  A result rather than an {@link AccountHeldError}: a refused link is the
 *  ordinary answer to a stale page, not the exceptional one it is for a create,
 *  where the account is the reason the person was being written at all. */
export type LinkResult = { linked: true } | { linked: false; holder: AccountHolder | null };

/** What a {@link PeopleRepository.merge} attempt did: absorbed the source,
 *  links and all, or refused and said which rule stopped it. The reason rather
 *  than the sentence, so the wording a caller answers with stays the
 *  contract's rather than this table's. */
export type MergeResult = { merged: true; links: number } | { merged: false; reason: MergeRefusal };

/** Why a merge did not happen. "unknown-*" describes an id that names nobody,
 *  and "guardian-source" a person who exists and stays. */
type MergeRefusal = "same-person" | "unknown-target" | "unknown-source" | "guardian-source";

/** What a {@link PeopleRepository.delete} attempt did: removed the person and
 *  returned this many accounts to strangers, or refused because the id names
 *  nobody or names the guardian. */
export type DeleteResult =
  | { deleted: true; links: number }
  | { deleted: false; reason: "unknown" | "guardian" };
