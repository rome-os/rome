// Entry for an account on a platform: who a message, a command or a press lets
// in. Contract: docs/architecture/access-control.md#entry.

import type { DrizzleDb } from "../../db/index.js";
import { createLogger } from "../../logger.js";
import { guardianActor } from "../session-actor.js";
import type { TeamActor } from "../team.js";
import { VisitorProfilesRepository } from "../visitor-profiles.js";
import { memberContext, ROME_CLOUD_EMAIL_PLATFORM } from "./members.js";

const log = createLogger("entry");

/** How an email connection names a sender whose address it could not verify.
 *  Compared as Identity compares accounts: trimmed and in lower case. */
const UNVERIFIED_EMAIL = "unauthenticated:";

export interface AccountEntryDeps {
  db: DrizzleDb;
  /** Whether `account` is linked as an agent acting for the guardian
   *  (docs/domains/people.md#delegate-link). Identity holds no agents yet. */
  actsForGuardian(account: { platform: string; id: string }): Promise<boolean>;
}

/** Who an account lets in, or whether Rome knows it at all. */
export type AccountEntry =
  | { kind: "entered"; person: TeamActor }
  | { kind: "unknown" }
  | { kind: "refused" };

const REFUSED: AccountEntry = { kind: "refused" };

/**
 * Answers who `account` lets in, as the actor of the work it starts: the
 * guardian or a member at the moment of the call, and the guardian for an agent
 * acting for them. An account nobody holds is unknown. A person with no role, an
 * account not named or verified and, logged, a member whose sign-in cannot be
 * found and an answer that cannot be had are refused.
 */
export function accountEntry(deps: AccountEntryDeps) {
  const members = memberContext(deps.db);

  const profiles = new VisitorProfilesRepository(deps.db);

  /** The guardian, by their own account, or by an agent acting for them: one
   *  that is not the guardian's own message is not marked as theirs. */
  const guardian = async (ownAccount: boolean): Promise<AccountEntry> => {
    const actor = await guardianActor(deps.db);
    if (actor?.kind !== "guardian") return REFUSED;
    return { kind: "entered", person: ownAccount ? { ...actor, via: "account" } : actor };
  };

  /** A member as their own sign-in names them. A member adds an account only
   *  while signed in, so one whose sign-in cannot be found is refused. */
  const member = async (personId: string): Promise<AccountEntry> => {
    const accounts = await members.identity.accountsOf(personId);
    const email = accounts.find((each) => each.platform === ROME_CLOUD_EMAIL_PLATFORM)?.accountId;
    const accountId = email ? await profiles.accountIdOf(email) : null;
    if (!email || !accountId) {
      log.warn("a member's sign-in could not be found", { personId });
      return REFUSED;
    }
    return { kind: "entered", person: { kind: "visitor", accountId, email } };
  };

  return async (account: { platform: string; id: string }): Promise<AccountEntry> => {
    const { platform, id } = account;
    if (!platform || !id.trim()) return REFUSED;
    if (platform === "email" && id.trim().toLowerCase().startsWith(UNVERIFIED_EMAIL))
      return REFUSED;
    try {
      const person = await members.identity.personOf({ platform, accountId: id });
      const role = person ? await members.access.roleOf(person.id) : null;
      if (role === "guardian") return await guardian(true);
      if (person && role === "member") return await member(person.id);
      if (await deps.actsForGuardian(account)) return await guardian(false);
      return person ? REFUSED : { kind: "unknown" };
    } catch (err) {
      log.warn("could not tell who an account is", {
        platform,
        error: err instanceof Error ? err.name : "unknown",
      });
      return REFUSED;
    }
  };
}
