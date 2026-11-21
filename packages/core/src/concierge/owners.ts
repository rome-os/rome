// Who each Concierge's owner is, and whether Rome still serves them. The
// guardian always is. A visitor is while their email is on the dashboard
// allow-list, and stops the moment they are dropped from it.

import type { SettingsRepository } from "../db/repositories/settings.js";
import type { VisitorProfilesRepository } from "../access/visitor-profiles.js";
import type { DashboardAccessState } from "../access/dashboard-access-state.js";
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
  /** Whether Rome serves this owner's Concierge now. */
  isServed(owner: ConciergeOwner): Promise<boolean>;
}

/** Every owner served, each named by role only. For tests and boot paths without people. */
export const ALL_OWNERS_SERVED: ConciergeOwners = {
  profileOf: async (owner) => ({ role: owner === GUARDIAN_OWNER ? "guardian" : "visitor" }),
  isServed: async () => true,
};

export function createConciergeOwners(deps: {
  settingsRepo: Pick<SettingsRepository, "get">;
  visitorProfiles: Pick<VisitorProfilesRepository, "getMany">;
  dashboardAccess: Pick<DashboardAccessState, "isCloudEmailAllowed">;
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
        return { role: "guardian", ...(typeof name === "string" && name ? { name } : {}) };
      }
      const email = await emailOf(owner);
      return { role: "visitor", ...(email ? { email } : {}) };
    },
    async isServed(owner) {
      if (owner === GUARDIAN_OWNER) return true;
      const email = await emailOf(owner);
      return email !== undefined && deps.dashboardAccess.isCloudEmailAllowed(email);
    },
  };
}
