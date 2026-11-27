// What @rome-os/app-runtime 0.11 handed apps for People, answered with no
// People code, so an app built against that release still runs. Each port
// answers nobody, or refuses a write as it did before; the guardian's
// accounts and the ports that never needed People keep working. Types: packages/app-runtime-sdk/src/deprecated-people.ts.
// A later breaking release deletes this file with that one.
//
// Each use adds one to a counter metric, so a symbol is deleted once no app
// uses it: docs/observability/schema.md#deprecated-app-sdk-symbols.

import type { Counter } from "@opentelemetry/api";
import type {
  Access,
  AgentRunnerInterface,
  AppRuntimeRepositories,
  ChatStopHandler,
  GuardianProfileRepository,
  PeopleService,
  PersonMappingRepository,
  PolicyEngine,
} from "@rome-os/app-runtime";
import { renameGuardianIn } from "../access/application/members.js";
import type { RomeAppRuntimeServices } from "../apps/context.js";
import type { ConnectionKindOfChannel } from "../db/repositories/channel-records.js";
import type { DrizzleDb } from "../db/index.js";
import type { SettingsRepository } from "../db/repositories/settings.js";
import { applyGuardianProfile } from "../instance/guardian-profile/index.js";
import { matchingPolicy } from "../participation/wake-gate/policy/policy-engine.js";
import { appSdkDeprecatedUsesMetric } from "../telemetry.js";
import type { Policy } from "../types.js";

/** The metric attributes naming the symbol and the app. */
export const DEPRECATED_USE_SYMBOL = "rome.app_sdk.symbol";
export const DEPRECATED_USE_APP = "rome.app.id";

/** Notes that app `appId` used `symbol`, a fixed name such as
 *  `personMappingRepo.findByChannelUser`. */
export type ReportDeprecatedUse = (appId: string, symbol: string) => void;

/**
 * A {@link ReportDeprecatedUse} that adds one to `rome.app_sdk.deprecated_uses`
 * per use, with the symbol and the app id as its only attributes.
 */
export function deprecatedUseReporter(
  counter: () => Pick<Counter, "add"> = appSdkDeprecatedUsesMetric,
): ReportDeprecatedUse {
  return (appId, symbol) => {
    counter().add(1, { [DEPRECATED_USE_SYMBOL]: symbol, [DEPRECATED_USE_APP]: appId });
  };
}

/** This process's reporter. */
const reportDeprecatedUse = deprecatedUseReporter();

/** The person id 0.11 handed apps for a sender linked to nobody. */
const STRANGER_PERSON_ID = "__STRANGER__";

/** `deps.people`: the guardian's accounts, as the app's `ctx.access` answers
 *  them, or none without it. */
function deprecatedPeople(
  used: (symbol: string) => void,
  access: Access | undefined,
): PeopleService {
  return {
    async guardian() {
      used("people.guardian");
      return { accounts: (await access?.guardianAccounts()) ?? [] };
    },
  };
}

/** `deps.personMappingRepo`: every lookup finds nobody, and every write is
 *  refused, as 0.11 already refused it. */
function deprecatedPersonMapping(used: (symbol: string) => void): PersonMappingRepository {
  const answer =
    <T>(method: string, value: T) =>
    async (): Promise<T> => {
      used(`personMappingRepo.${method}`);
      return value;
    };
  const refused = (method: string, what: string) => async (): Promise<never> => {
    used(`personMappingRepo.${method}`);
    throw new Error(`Apps cannot ${what}. Rome no longer keeps persons for apps.`);
  };
  return {
    findByChannelUser: answer("findByChannelUser", null),
    findByAccount: answer("findByAccount", null),
    findByName: answer("findByName", []),
    findByNameFuzzy: answer("findByNameFuzzy", null),
    findByBondLevel: answer("findByBondLevel", []),
    create: refused("create", "add persons"),
    addChannelMapping: refused("addChannelMapping", "link accounts to persons"),
    addAccount: refused("addAccount", "link accounts to persons"),
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

/** `target` with each method named in `uses` reporting the symbol it
 *  answers for its arguments, if any, before it runs. */
function reportingMethods<T extends object>(
  target: T,
  uses: Record<string, (args: unknown[]) => string | undefined>,
  used: (symbol: string) => void,
): T {
  return new Proxy(target, {
    get(object, property) {
      const value = Reflect.get(object, property, object);
      if (typeof value !== "function") return value;
      const use = typeof property === "string" ? uses[property] : undefined;
      if (!use) return value.bind(object);
      return (...args: unknown[]) => {
        const symbol = use(args);
        if (symbol) used(symbol);
        return value.apply(object, args);
      };
    },
  });
}

const firstArg = (args: unknown[]) => args[0] as Record<string, unknown> | undefined;

/** A run whose thread context still names the sender's bond level. */
const bondLevelInRun = (args: unknown[]) => {
  const context = firstArg(args)?.threadContext as Record<string, unknown> | undefined;
  return context?.senderBondLevel !== undefined ? "ThreadContext.senderBondLevel" : undefined;
};

/**
 * `deps`, the action deps of app `appId`, with what 0.11 handed every app
 * action beside them: `people` (answered from `deps.appContext.access`),
 * `personMappingRepo` and `strangerPersonId` added, and the shared `policyEngine`, `approvalsRepo` and `agentRunner`
 * reporting their deprecated uses. Call it on the finished object, since
 * `strangerPersonId` reports from a getter. The getter is enumerable, as the
 * 0.11 field was, so a copy such as `{ ...deps }` still carries the id, and
 * copying or serializing `deps` counts as a use.
 */
export function withDeprecatedActionDeps<T extends Record<string, unknown>>(
  appId: string,
  deps: T,
  report: ReportDeprecatedUse = reportDeprecatedUse,
): T {
  const used = (symbol: string) => report(appId, symbol);
  const target = deps as Record<string, unknown>;
  target.people ??= deprecatedPeople(
    used,
    (target.appContext as { access?: Access } | undefined)?.access,
  );
  target.personMappingRepo ??= deprecatedPersonMapping(used);
  if (!("strangerPersonId" in target)) {
    Object.defineProperty(target, "strangerPersonId", {
      configurable: true,
      enumerable: true,
      get() {
        used("strangerPersonId");
        return STRANGER_PERSON_ID;
      },
    });
  }
  const policyEngine = target.policyEngine as PolicyEngine | undefined;
  if (policyEngine) {
    target.policyEngine = {
      evaluate(context) {
        used("policyEngine.evaluate");
        return policyEngine.evaluate(context);
      },
    } satisfies PolicyEngine;
  }
  if (target.approvalsRepo && typeof target.approvalsRepo === "object") {
    target.approvalsRepo = reportingMethods(
      target.approvalsRepo,
      {
        create: (args) =>
          firstArg(args)?.type === "person_mapping" ? "APPROVAL_TYPES.person_mapping" : undefined,
      },
      used,
    );
  }
  if (target.agentRunner && typeof target.agentRunner === "object") {
    target.agentRunner = deprecatedAgentRunnerFor(
      target.agentRunner as AgentRunnerInterface,
      appId,
      report,
    );
  }
  return deps;
}

/** App `appId`'s agent runner, with `run` and `runForked` reporting a
 *  thread context that still names the sender's bond level. */
export function deprecatedAgentRunnerFor(
  agentRunner: AgentRunnerInterface,
  appId: string,
  report: ReportDeprecatedUse = reportDeprecatedUse,
): AgentRunnerInterface {
  return reportingMethods(
    agentRunner,
    { run: bondLevelInRun, runForked: bondLevelInRun },
    (symbol) => report(appId, symbol),
  );
}

/** App `appId`'s repositories, with `guardianProfile` reporting each write. */
export function deprecatedRepositoriesFor(
  repositories: AppRuntimeRepositories,
  appId: string,
  report: ReportDeprecatedUse = reportDeprecatedUse,
): AppRuntimeRepositories {
  const guardianProfile = repositories.guardianProfile;
  if (!guardianProfile) return repositories;
  return {
    ...repositories,
    guardianProfile: {
      write(input) {
        report(appId, "repositories.guardianProfile.write");
        return guardianProfile.write(input);
      },
    },
  };
}

/**
 * A `RomeAppRuntimeServices.forApp` over `services`: app `appId`'s
 * repositories and agent runner, each reporting that app's deprecated uses.
 * It reads `services` on each call, so a field set after it is built counts.
 */
export function deprecatedPortsFor(
  services: Pick<RomeAppRuntimeServices, "repositories" | "agentRunner">,
  report: ReportDeprecatedUse = reportDeprecatedUse,
): NonNullable<RomeAppRuntimeServices["forApp"]> {
  return (appId) => ({
    repositories: deprecatedRepositoriesFor(services.repositories, appId, report),
    agentRunner:
      services.agentRunner && deprecatedAgentRunnerFor(services.agentRunner, appId, report),
  });
}

/** App `appId`'s `chatStop`, reporting the `service` and `senderId` it
 *  still passes, which the host ignores. */
export function deprecatedChatStopFor(
  chatStop: ChatStopHandler,
  appId: string,
  report: ReportDeprecatedUse = reportDeprecatedUse,
): ChatStopHandler {
  return (input) => {
    if (input.service !== undefined) report(appId, "ChatStopInput.service");
    if (input.senderId !== undefined) report(appId, "ChatStopInput.senderId");
    return chatStop(input);
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
