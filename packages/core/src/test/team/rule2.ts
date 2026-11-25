// Rule 2: every dashboard operation, called once as the guardian and once as a
// teammate on instances in the same state, comes to the same outcome. Also:
// every operation refuses a signed-out caller, and refuses a visitor nobody put
// on the dashboard list, except the operations public.json names as public.
// Each role calls every operation in the same order on its own instance.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  createInstance,
  mountDrift,
  OUTSIDER,
  TEAMMATE,
  type InstanceOptions,
} from "./instance.js";
import {
  callHttp,
  callUpgrade,
  unclaimedUpgradeHandlers,
  type Outcome,
  type Role,
} from "./callers.js";
import { httpOperations, pathFor, upgradeOperations, type Operation } from "./surface.js";
import { guardianOnlyFeature, openSocket, STAND_IN_OPEN_SOCKET_PATH } from "./stand-in-routes.js";
import { refusedLaunches } from "./sandbox.js";

/**
 * A product the verifier is proven against instead of the one in the tree.
 * "open-checks": the teammate's calls carry the guardian's session, so every
 * check admits them as it admits the guardian. "admit-every-visitor": the
 * outsider's email is on the dashboard list too, so the product admits a
 * visitor nobody invited. "guardian-only-route": the product in the tree plus
 * the routes in `stand-in-routes.ts`, which refuse everyone but the guardian.
 * "open-socket": the product in the tree plus a WebSocket path that admits
 * everyone.
 */
export type StandIn = "open-checks" | "admit-every-visitor" | "guardian-only-route" | "open-socket";

export interface Rule2Options {
  standIn?: StandIn;
}

export type Verdict =
  | "match"
  | "teammate-refused"
  | "status-differs"
  | "unverified"
  | "exception"
  | "out-of-scope";

/** How an operation treats a caller it must refuse. "public": public.json
 *  names the operation, so the caller may be admitted. */
type Gate = "refused" | "admitted" | "public";

export interface OperationResult {
  route: string;
  path: string;
  kind: Operation["kind"];
  reach: Operation["reach"];
  verdict: Verdict;
  exception?: string;
  outcomes: Partial<Record<Role, Outcome>>;
  /** Unset for an operation out of scope. */
  anonymous?: Gate;
  outsider?: Gate;
}

export interface Rule2Result {
  pass: boolean;
  operations: OperationResult[];
  teammateRefused: string[];
  statusDiffers: string[];
  /** Routes where guardian and teammate got the same 400, 404, 422, 5xx or
   *  timeout, so the call may never have reached the guard it would compare.
   *  Neither a match nor a failure. */
  unverified: string[];
  /** Operations public.json does not name that answer a signed-out caller
   *  with anything but 401 or 403. */
  anonymousAdmitted: string[];
  /** The same, for a visitor nobody put on the dashboard list. */
  outsiderAdmitted: string[];
  /** Operations public.json names that refuse a signed-out caller, or that
   *  the surface no longer has. */
  stalePublic: string[];
  /** Programs a call launched that the sandbox has no stub for. */
  refusedLaunches: string[];
  unclaimedUpgradeHandlers: number[];
  mountDrift: string[];
  outOfScope: { route: string; reach: Operation["reach"] }[];
}

interface ExceptionsFile {
  exceptions: { name: string; routes: string[] }[];
}

const readTeamFile = <T>(name: string): T =>
  JSON.parse(readFileSync(join(process.cwd(), "src", "test", "team", name), "utf8")) as T;

function readExceptions(): Map<string, string> {
  const byRoute = new Map<string, string>();
  for (const exception of readTeamFile<ExceptionsFile>("exceptions.json").exceptions) {
    for (const route of exception.routes) byRoute.set(route, exception.name);
  }
  return byRoute;
}

/** The operations public.json names: each answers a signed-out caller by design. */
function publicOperations(): string[] {
  return readTeamFile<{ operations: { route: string }[] }>("public.json").operations.map(
    (entry) => entry.route,
  );
}

function instanceOptions(standIn: StandIn | undefined): InstanceOptions {
  return {
    dashboardEmails:
      standIn === "admit-every-visitor" ? [TEAMMATE.email, OUTSIDER.email] : [TEAMMATE.email],
    ...(standIn === "guardian-only-route" ? { extraFeatures: [guardianOnlyFeature()] } : {}),
    ...(standIn === "open-socket" ? { extraUpgrades: [openSocket()] } : {}),
  };
}

/** The role whose session a call carries. The open-checks stand-in hands the
 *  teammate the guardian's. */
function sessionRole(role: Role, standIn: StandIn | undefined): Role {
  return role === "teammate" && standIn === "open-checks" ? "guardian" : role;
}

function knownUpgrades(standIn: StandIn | undefined): Operation[] {
  const ops = upgradeOperations();
  if (standIn !== "open-socket") return ops;
  return [
    ...ops,
    {
      kind: "ws",
      route: `WS ${STAND_IN_OPEN_SOCKET_PATH}`,
      path: STAND_IN_OPEN_SOCKET_PATH,
      reach: "edge-open",
    },
  ];
}

/** Every operation in order on one instance for `role`. A write that changes
 *  the dashboard list (a teammate may save it) would sign the teammate out of
 *  the calls after it, so the list goes back to the booted one after each
 *  call. */
async function callAllAs(
  ops: Operation[],
  role: Role,
  standIn: StandIn | undefined,
): Promise<Map<string, Outcome>> {
  const instance = await createInstance(instanceOptions(standIn));
  try {
    const listening = await instance.listen();
    const outcomes = new Map<string, Outcome>();
    const as = sessionRole(role, standIn);
    try {
      for (const op of ops) {
        let outcome: Outcome;
        if (op.kind === "http") {
          const own =
            httpOperations(instance.app, instance.ids).find((o) => o.route === op.route) ?? op;
          outcome = await callHttp(
            instance.app,
            { ...own, path: pathFor(own, instance.ids, as) },
            as,
          );
        } else {
          outcome = await callUpgrade(instance.app, listening.port, op, as);
        }
        outcomes.set(op.route, outcome);
        await instance.restoreDashboardList();
      }
    } finally {
      await listening.close();
    }
    return outcomes;
  } finally {
    await instance.close();
  }
}

// A 400 or 422 may come from body validation that runs before the guard.
const unusable = (status: Outcome["status"]) =>
  status === "timeout" || status === 400 || status === 404 || status === 422 || status >= 500;

function compare(guardian: Outcome, teammate: Outcome): Verdict {
  if (!guardian.refused && teammate.refused) return "teammate-refused";
  if (guardian.status !== teammate.status) return "status-differs";
  if (unusable(guardian.status)) return "unverified";
  return "match";
}

export async function runRule2(options: Rule2Options = {}): Promise<Rule2Result> {
  const { standIn } = options;
  const exceptions = readExceptions();
  const publicRoutes = publicOperations();
  const launchesBefore = refusedLaunches().length;

  const surface = await createInstance(instanceOptions(standIn));
  let operations: Operation[];
  let unclaimed: number[];
  try {
    operations = [...httpOperations(surface.app, surface.ids), ...knownUpgrades(standIn)];
    const listening = await surface.listen();
    try {
      unclaimed = await unclaimedUpgradeHandlers(
        listening.server,
        listening.port,
        knownUpgrades(standIn).map((op) => op.path),
      );
    } finally {
      await listening.close();
    }
  } finally {
    await surface.close();
  }
  const inScope = operations.filter((op) => op.reach !== "machine" && op.reach !== "loopback-only");

  // Deletes go last, so a seeded record one removes is still there for the
  // operations that read or change it, and the deepest path first, so a
  // record goes before the record it sits under.
  const isDelete = (op: Operation) => op.kind === "http" && op.method === "DELETE";
  const depth = (op: Operation) => op.path.split("/").length;
  const ordered = [
    ...inScope.filter((op) => !isDelete(op)),
    ...inScope.filter(isDelete).sort((a, b) => depth(b) - depth(a)),
  ];
  const byRole = new Map<Role, Map<string, Outcome>>();
  for (const role of ["guardian", "teammate", "anonymous", "outsider"] as const) {
    byRole.set(role, await callAllAs(ordered, role, standIn));
  }
  const outcomeOf = (op: Operation, role: Role): Outcome => {
    const outcome = byRole.get(role)?.get(op.route);
    if (!outcome) throw new Error(`no ${role} outcome for ${op.route}`);
    return outcome;
  };

  const results: OperationResult[] = [];
  for (const op of operations) {
    const base = { route: op.route, path: op.path, kind: op.kind, reach: op.reach };
    if (!inScope.includes(op)) {
      results.push({ ...base, verdict: "out-of-scope", outcomes: {} });
      continue;
    }
    const outcomes = {
      guardian: outcomeOf(op, "guardian"),
      teammate: outcomeOf(op, "teammate"),
      anonymous: outcomeOf(op, "anonymous"),
      outsider: outcomeOf(op, "outsider"),
    };
    const exception = exceptions.get(op.route);
    const isPublic = publicRoutes.includes(op.route);
    const gate = (outcome: Outcome): Gate =>
      isPublic ? "public" : outcome.refused ? "refused" : "admitted";
    results.push({
      ...base,
      verdict: exception ? "exception" : compare(outcomes.guardian, outcomes.teammate),
      ...(exception ? { exception } : {}),
      outcomes,
      anonymous: gate(outcomes.anonymous),
      outsider: gate(outcomes.outsider),
    });
  }

  const routesWith = (verdict: Verdict) =>
    results.filter((r) => r.verdict === verdict).map((r) => r.route);
  const admitted = (role: "anonymous" | "outsider") =>
    results.filter((r) => r[role] === "admitted").map((r) => r.route);
  const stalePublic = publicRoutes.filter((route) => {
    const result = results.find((r) => r.route === route);
    return !result || result.outcomes.anonymous?.refused !== false;
  });
  const drift = mountDrift();
  const teammateRefused = routesWith("teammate-refused");
  const statusDiffers = routesWith("status-differs");
  const anonymousAdmitted = admitted("anonymous");
  const outsiderAdmitted = admitted("outsider");
  const launches = refusedLaunches().slice(launchesBefore);
  return {
    pass:
      teammateRefused.length === 0 &&
      statusDiffers.length === 0 &&
      anonymousAdmitted.length === 0 &&
      outsiderAdmitted.length === 0 &&
      stalePublic.length === 0 &&
      launches.length === 0 &&
      unclaimed.length === 0 &&
      drift.length === 0,
    operations: results,
    teammateRefused,
    statusDiffers,
    unverified: routesWith("unverified"),
    anonymousAdmitted,
    outsiderAdmitted,
    stalePublic,
    refusedLaunches: [...launches],
    unclaimedUpgradeHandlers: unclaimed,
    mountDrift: drift,
    outOfScope: results
      .filter((r) => r.verdict === "out-of-scope")
      .map((r) => ({ route: r.route, reach: r.reach })),
  };
}
