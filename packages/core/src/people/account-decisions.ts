// The two writes that decide an account: dismiss it, or restore it to nobody's
// decision. What they mean is the account contract's (@rome/api-types/people);
// where they are stored is the stranger sentinel, which is what "dismissed" has
// always been in this database.
//
// Neither verb invents storage. A dismissal is a channel mapping onto the
// sentinel — the row the dismiss verb has always written — and a
// restore is that row's removal. What is new is that both are addressed at an
// account rather than at the sentinel, and that neither can reach an account a
// real person holds: linking and unlinking are that account's verbs, and a
// dismissal that quietly displaced a placement would lose the guardian's work.
//
// The account, not the address. A channel that reaches one account several
// ways is folded by `readAccountDirectory`, so a caller holding any address of
// an account decides the account — otherwise a dismissal by the address the
// guardian happened to see would leave the account undismissed by every other
// one.

import {
  accountPresentation,
  accountRef,
  linkConflict,
  type DirectoryAccount,
  type LinkConflict,
} from "@rome/api-types/people";
import { STRANGER_PERSON_DISPLAY_NAME, STRANGER_PERSON_ID } from "../constants.js";
import { readAccountDirectory, type AccountDirectoryDeps } from "./account-directory.js";
import type { PeopleRepository } from "../db/repositories/people.js";

export interface AccountDecisionDeps extends AccountDirectoryDeps {
  peopleRepo: AccountDirectoryDeps["peopleRepo"] & Pick<PeopleRepository, "dismiss" | "restore">;
}

/** The account a write names: any address the channel reaches it at. */
export interface AccountRef {
  channel: string;
  channelUserId: string;
}

/**
 * What a decision came to: the account as it reads now, the person who refused
 * it, or nothing to decide about.
 *
 * `unknown` is its own answer rather than a decision on an empty account: Rome
 * never mints an account, so a pair no source has observed is a caller's stale
 * page or typo, and writing a dismissal for it would file a decision about
 * nobody — and, since a mapping is itself an observation, conjure the account
 * into the directory to hold it.
 */
export type AccountDecision =
  | { account: DirectoryAccount }
  | { conflict: LinkConflict }
  | { unknown: true };

/**
 * File an account under the stranger sentinel.
 *
 * Idempotent: an account already dismissed is answered as dismissed and not
 * written again, so a double-click cannot leave two claims on one account.
 */
export async function dismissAccount(
  deps: AccountDecisionDeps,
  ref: AccountRef,
): Promise<AccountDecision> {
  const account = await locate(deps, ref);
  if (account == null) return { unknown: true };

  // What the guardian was looking at. It refuses the account they can see is
  // placed — including one placed on an address other than the one they
  // named, which only the fold knows is the same account.
  const holder = heldBy(account);
  if (holder) return { conflict: linkConflict(account, holder) };

  if (account.state !== "dismissed") {
    // And what is true at the moment of writing. The read above cannot see a
    // placement that lands after it, so the write is a compare-and-swap rather
    // than a re-point: a dismissal is a link onto the sentinel, and it is
    // claimed on the same terms as any other link — declaring no owner to take
    // it from, which is a claim only an account nobody holds can satisfy.
    // Without that, a link arriving in the gap would be re-pointed onto the
    // sentinel and lost, which is the harm the refusal above exists to prevent
    // reached by a different route.
    const claim = await deps.peopleRepo.dismiss({
      channel: account.channel,
      channelUserId: account.channelUserId,
    });
    if (!claim.linked) {
      // A claim that names no owner to take the account from is refused only
      // by someone holding it, so there is always a person to name here.
      if (!claim.holder) {
        throw new Error(`dismissing ${accountRef(account)} was refused by nobody`);
      }
      return {
        conflict: linkConflict(account, {
          id: claim.holder.personId,
          displayName: claim.holder.personName,
        }),
      };
    }
  }

  return decided(account, {
    personId: STRANGER_PERSON_ID,
    displayName: STRANGER_PERSON_DISPLAY_NAME,
  });
}

/**
 * Undo a dismissal, leaving the account observed and nobody's.
 *
 * Idempotent in the same way, and refuses a placed account for the same reason
 * dismiss does: restoring is the undo of a dismissal, and an account a person
 * holds carries none — clearing their link is unlink's job, under their name.
 */
export async function restoreAccount(
  deps: AccountDecisionDeps,
  ref: AccountRef,
): Promise<AccountDecision> {
  const account = await locate(deps, ref);
  if (account == null) return { unknown: true };

  const holder = heldBy(account);
  if (holder) return { conflict: linkConflict(account, holder) };

  if (account.state === "dismissed") {
    // Every address, because the dismissal is stored against whichever one it
    // was made by, and an account still claimed by one of its other addresses
    // would read as dismissed the moment the fold ran again.
    //
    // No conditional claim to lose here: the release is already scoped to the
    // sentinel's own rows, so a link landing in the same gap is not a row this
    // write can touch.
    await deps.peopleRepo.restore(account.channel, account.addresses);
  }

  return decided(account, null);
}

/**
 * The person a refusal names, or null when the account is nobody's and a write
 * may proceed.
 *
 * Read off the account's presentation rather than its stored link, so the owner
 * can never be the stranger sentinel: a dismissed account presents as
 * "dismissed" with no person, and a dismissal is what these two verbs are for.
 */
function heldBy(account: DirectoryAccount): { id: string; displayName: string } | null {
  if (account.state !== "linked" || account.personId == null) return null;
  return { id: account.personId, displayName: account.personName ?? account.personId };
}

/**
 * The account behind an address, or null when nothing has observed it.
 *
 * Read through the directory rather than through the mapping table: the
 * directory is what decided the account's state, which addresses are one
 * account, and which person holds it, and a write that answered those questions
 * a second way could refuse what the guardian is looking at, or dismiss an
 * address of an account it is not allowed to touch.
 */
async function locate(
  deps: AccountDecisionDeps,
  ref: AccountRef,
): Promise<DirectoryAccount | null> {
  const directory = await readAccountDirectory(deps);
  return (
    directory.find(
      (account) =>
        account.channel === ref.channel &&
        (account.channelUserId === ref.channelUserId ||
          account.addresses.includes(ref.channelUserId)),
    ) ?? null
  );
}

/**
 * The row a landed write answers with: the account as the directory would list
 * it now.
 *
 * Patched rather than re-read. A decision moves the link and nothing else — the
 * platform's name for the account, the addresses it answers to and whether
 * anything is on record for it are all untouched — so re-folding every address
 * book to learn what this function already holds would buy nothing but a second
 * chance to disagree with the read that made the decision.
 *
 * The link goes through the same presentation seam a directory row does, which
 * is what keeps the sentinel off the wire here.
 */
function decided(
  account: DirectoryAccount,
  link: { personId: string; displayName: string } | null,
): AccountDecision {
  return { account: { ...account, ...accountPresentation(link) } };
}
