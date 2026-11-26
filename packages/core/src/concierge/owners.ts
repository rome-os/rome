// Who each Concierge's owner is.

import type { SettingsRepository } from "../db/repositories/settings.js";
import type { VisitorProfilesRepository } from "../access/visitor-profiles.js";
import { type ConciergeOwner, GUARDIAN_OWNER } from "../webchat/owner.js";

const VISITOR_PREFIX = "visitor:";

/** The Rome Cloud account a push for `owner` names: a visitor's, or undefined for the guardian. */
export function recipientOf(owner: ConciergeOwner): string | undefined {
  return owner.startsWith(VISITOR_PREFIX) ? owner.slice(VISITOR_PREFIX.length) : undefined;
}

/** An owner as their Concierge's turns name them. */
export interface OwnerProfile {
  role: "guardian" | "visitor";
  name?: string;
  email?: string;
}

export interface ConciergeOwners {
  profileOf(owner: ConciergeOwner): Promise<OwnerProfile>;
}

/** Each owner named by role only. For tests and boot paths without people. */
export const OWNERS_BY_ROLE: ConciergeOwners = {
  profileOf: async (owner) => ({ role: owner === GUARDIAN_OWNER ? "guardian" : "visitor" }),
};

export function createConciergeOwners(deps: {
  settingsRepo: Pick<SettingsRepository, "get">;
  visitorProfiles: Pick<VisitorProfilesRepository, "getMany">;
  /** The email the guardian signs in with, which names them until they set a name. */
  guardianEmail?: () => Promise<string | null | undefined>;
}): ConciergeOwners {
  const emailOf = async (owner: ConciergeOwner): Promise<string | undefined> => {
    if (!owner.startsWith(VISITOR_PREFIX)) return undefined;
    const accountId = owner.slice(VISITOR_PREFIX.length);
    return (await deps.visitorProfiles.getMany([accountId])).get(accountId)?.email;
  };
  return {
    async profileOf(owner) {
      if (owner === GUARDIAN_OWNER) {
        const name = await deps.settingsRepo.get("guardianName");
        if (typeof name === "string" && name) return { role: "guardian", name };
        const email = await deps.guardianEmail?.();
        return { role: "guardian", ...(email ? { email } : {}) };
      }
      const email = await emailOf(owner);
      return { role: "visitor", ...(email ? { email } : {}) };
    },
  };
}
