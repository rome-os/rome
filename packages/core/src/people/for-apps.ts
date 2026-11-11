// What People offers apps through `ctx.repositories`: the guardian's profile,
// which an app writes during onboarding.

import type { GuardianProfileRepository } from "@rome-os/app-runtime";
import type { DrizzleDb } from "../db/index.js";
import type { SettingsRepository } from "../db/repositories/settings.js";
import { applyGuardianProfile } from "./guardian-profile.js";

export function appGuardianProfile(deps: {
  db: DrizzleDb;
  settingsRepo: SettingsRepository;
  /** Reschedules floating routines, which follow the guardian's timezone. */
  reactivateFloating: () => Promise<void>;
}): GuardianProfileRepository {
  return {
    write: async (input) => {
      const result = await applyGuardianProfile(
        { guardianName: input.guardianName, agentName: input.agentName },
        deps,
      );
      return { ok: result.ok };
    },
  };
}
