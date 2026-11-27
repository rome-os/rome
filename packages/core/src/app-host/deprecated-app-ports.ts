// What @rome-os/app-runtime 0.11 handed apps for People, answered with no
// People code, so an app built against that release still runs. Each port
// answers nobody, or refuses a write as it did before; the two that never
// needed People keep working. Types: packages/app-runtime-sdk/src/deprecated-people.ts.
// A later breaking release deletes this file with that one.

import type {
  GuardianProfileRepository,
  PeopleService,
  PersonMappingRepository,
  PolicyEngine,
} from "@rome-os/app-runtime";
import { renameGuardianIn } from "../access/application/members.js";
import type { ConnectionKindOfChannel } from "../db/repositories/channel-records.js";
import type { DrizzleDb } from "../db/index.js";
import type { SettingsRepository } from "../db/repositories/settings.js";
import { applyGuardianProfile } from "../instance/guardian-profile/index.js";
import { matchingPolicy } from "../participation/wake-gate/policy/policy-engine.js";
import type { Policy } from "../types.js";

/** The person id 0.11 handed apps for a sender linked to nobody. */
const STRANGER_PERSON_ID = "__STRANGER__";

/** `deps.people`: the guardian has no accounts here. */
function deprecatedPeople(): PeopleService {
  return {
    async guardian() {
      return { accounts: [] };
    },
  };
}

/** `deps.personMappingRepo`: every lookup finds nobody, and every write is
 *  refused, as 0.11 already refused it. */
function deprecatedPersonMapping(): PersonMappingRepository {
  const refused = (what: string) => async (): Promise<never> => {
    throw new Error(`Apps cannot ${what}. Rome no longer keeps persons for apps.`);
  };
  return {
    async findByChannelUser() {
      return null;
    },
    async findByAccount() {
      return null;
    },
    async findByName() {
      return [];
    },
    async findByNameFuzzy() {
      return null;
    },
    async findByBondLevel() {
      return [];
    },
    create: refused("add persons"),
    addChannelMapping: refused("link accounts to persons"),
    addAccount: refused("link accounts to persons"),
  };
}

/** `deps.policyEngine`: the guardian's thread, channel and global policies,
 *  and `allow` when none matches. */
export function deprecatedPolicyEngine(input: {
  policies: () => Promise<readonly Policy[]>;
  connectionKindOf: ConnectionKindOfChannel;
}): PolicyEngine {
  return {
    async evaluate(context) {
      const policies = await input.policies();
      return (
        matchingPolicy({ policies, connectionKindOf: input.connectionKindOf }, context) ?? {
          action: "allow",
        }
      );
    },
  };
}

/** The action deps 0.11 handed every app action, beside `policyEngine`,
 *  which each process builds once with {@link deprecatedPolicyEngine}. */
export function deprecatedActionDeps(): Record<string, unknown> {
  return {
    people: deprecatedPeople(),
    personMappingRepo: deprecatedPersonMapping(),
    strangerPersonId: STRANGER_PERSON_ID,
  };
}

/** `ctx.repositories.guardianProfile`, in the main process only: sets the
 *  guardian's name and the agent's name through Instance's setup path. */
export function deprecatedGuardianProfile(deps: {
  db: DrizzleDb;
  settingsRepo: SettingsRepository;
  /** Reschedules floating routines, which follow the guardian's timezone. */
  reactivateFloating: () => Promise<void>;
}): GuardianProfileRepository {
  return {
    write: async (input) => {
      const result = await applyGuardianProfile(
        { guardianName: input.guardianName, agentName: input.agentName },
        { ...deps, renameGuardian: renameGuardianIn(deps.db) },
      );
      return { ok: result.ok };
    },
  };
}
