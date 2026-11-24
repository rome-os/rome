// Rule 2: every dashboard operation, called once as the guardian and once as a
// teammate on instances in the same state, comes to the same outcome. Also: a
// visitor not on the dashboard list stays refused wherever the guardian is
// admitted and a signed-out caller is not.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Hono } from "hono";
import type { Feature } from "../../api/deps.js";
import { guardianOnly } from "../../access/guardian-only.js";
import {
  createInstance,
  mountDrift,
  OUTSIDER,
  TEAMMATE,
  type Instance,
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

/**
 * A product the verifier is proven against instead of the one in the tree.
 * "open-checks": the teammate's calls carry the guardian's session, so every
 * check admits them as it admits the guardian. "admit-every-visitor": the
 * outsider's email is on the dashboard list too, so the product admits a
 * visitor nobody invited. "guardian-only-route": the product in the tree plus
 * `STAND_IN_GUARDIAN_ONLY_ROUTE`, which refuses everyone but the guardian.
 */
export type StandIn = "open-checks" | "admit-every-visitor" | "guardian-only-route";

/**
 * "per-call" gives every call a fresh instance, so no call sees what another
 * changed: about 1,000 boots. "per-role" runs every operation in the same
 * order on one instance per role: 4 boots, and an operation after one that
 * changed state compares instances that went through the same calls.
 */
export type Isolation = "per-call" | "per-role";

export interface Rule2Options {
  standIn?: StandIn;
  /** Default "per-call". */
  isolation?: Isolation;
}

export const STAND_IN_GUARDIAN_ONLY_ROUTE = "GET /api/team-verifier/guardian-only";

export type Verdict =
  | "match"
  | "teammate-refused"
  | "status-differs"
  | "unverified"
  | "exception"
  | "out-of-scope";

export interface OperationResult {
  route: string;
  path: string;
  kind: Operation["kind"];
  reach: Operation["reach"];
  verdict: Verdict;
  exception?: string;
  outcomes: Partial<Record<Role, Outcome>>;
  /** Set where the guardian is admitted and a signed-out caller is refused. */
  outsider?: "refused" | "admitted";
}

export interface Rule2Result {
  pass: boolean;
  operations: OperationResult[];
  teammateRefused: string[];
  statusDiffers: string[];
  /** Routes where guardian and teammate got the same 404, 5xx or timeout, so
   *  the call never reached what it would compare. Reported, never passed or
   *  failed. */
  unverified: string[];
  outsiderAdmitted: string[];
  unclaimedUpgradeHandlers: number[];
  mountDrift: string[];
  outOfScope: { route: string; reach: Operation["reach"] }[];
}

interface ExceptionsFile {
  exceptions: { name: string; routes: string[] }[];
}

function readExceptions(): Map<string, string> {
  const file = JSON.parse(
    readFileSync(join(process.cwd(), "src", "test", "team", "exceptions.json"), "utf8"),
  ) as ExceptionsFile;
  const byRoute = new Map<string, string>();
  for (const exception of file.exceptions) {
    for (const route of exception.routes) byRoute.set(route, exception.name);
  }
  return byRoute;
}

function instanceOptions(standIn: StandIn | undefined): InstanceOptions {
  return {
    dashboardEmails:
      standIn === "admit-every-visitor" ? [TEAMMATE.email, OUTSIDER.email] : [TEAMMATE.email],
    ...(standIn === "guardian-only-route" ? { extraFeatures: [guardianOnlyFeature()] } : {}),
  };
}

function guardianOnlyFeature(): Feature {
  const routes = new Hono();
  const path = STAND_IN_GUARDIAN_ONLY_ROUTE.slice("GET /api".length);
  routes.get(path, guardianOnly, (c) => c.json({ ok: true }));
  return { routes, actions: [] };
}

/** The role whose session a call carries. The open-checks stand-in hands the
 *  teammate the guardian's. */
function sessionRole(role: Role, standIn: StandIn | undefined): Role {
  return role === "teammate" && standIn === "open-checks" ? "guardian" : role;
}

async function onFreshInstance<T>(
  standIn: StandIn | undefined,
  run: (instance: Instance) => Promise<T>,
): Promise<T> {
  const instance = await createInstance(instanceOptions(standIn));
  try {
    return await run(instance);
  } finally {
    await instance.close();
  }
}

/** Calls `op` on `instance`, filling its parameters from that instance's seeded ids. */
async function callOn(instance: Instance, port: number, op: Operation, as: Role): Promise<Outcome> {
  if (op.kind === "http") {
    const own = httpOperations(instance.app, instance.ids).find((o) => o.route === op.route) ?? op;
    return callHttp(instance.app, { ...own, path: pathFor(own, instance.ids, as) }, as);
  }
  return callUpgrade(instance.app, port, op, as);
}

async function callOnFreshInstance(
  op: Operation,
  role: Role,
  standIn: StandIn | undefined,
): Promise<Outcome> {
  return onFreshInstance(standIn, async (instance) => {
    const as = sessionRole(role, standIn);
    // Only an upgrade needs the instance on a port.
    if (op.kind === "http") return callOn(instance, 0, op, as);
    const listening = await instance.listen();
    try {
      return await callOn(instance, listening.port, op, as);
    } finally {
      await listening.close();
    }
  });
}

/** Every operation in order on one instance for `role`. A write that changes
 *  the dashboard list (a teammate may save it, and every call sends `{}`)
 *  would sign the teammate out of the calls after it, so the list goes back
 *  to the booted one after each call. */
async function callAllAs(
  ops: Operation[],
  role: Role,
  standIn: StandIn | undefined,
): Promise<Map<string, Outcome>> {
  return onFreshInstance(standIn, async (instance) => {
    const listening = await instance.listen();
    const outcomes = new Map<string, Outcome>();
    try {
      for (const op of ops) {
        outcomes.set(
          op.route,
          await callOn(instance, listening.port, op, sessionRole(role, standIn)),
        );
        await instance.restoreDashboardList();
      }
    } finally {
      await listening.close();
    }
    return outcomes;
  });
}

const unusable = (status: Outcome["status"]) =>
  status === "timeout" || status === 404 || status >= 500;

function compare(guardian: Outcome, teammate: Outcome): Verdict {
  if (!guardian.refused && teammate.refused) return "teammate-refused";
  if (guardian.status !== teammate.status) return "status-differs";
  if (unusable(guardian.status)) return "unverified";
  return "match";
}

export async function runRule2(options: Rule2Options = {}): Promise<Rule2Result> {
  const { standIn, isolation = "per-call" } = options;
  const exceptions = readExceptions();

  const { operations, unclaimed } = await onFreshInstance(standIn, async (instance) => {
    const ops: Operation[] = [
      ...httpOperations(instance.app, instance.ids),
      ...upgradeOperations(),
    ];
    const listening = await instance.listen();
    try {
      const unclaimedHandlers = await unclaimedUpgradeHandlers(
        listening.server,
        listening.port,
        upgradeOperations().map((op) => op.path),
      );
      return { operations: ops, unclaimed: unclaimedHandlers };
    } finally {
      await listening.close();
    }
  });
  const inScope = operations.filter((op) => op.reach !== "machine" && op.reach !== "loopback-only");

  // Per role, each role's outcomes come from one instance; per call, each
  // outcome is fetched when the comparison needs it.
  const byRole = new Map<Role, Map<string, Outcome>>();
  if (isolation === "per-role") {
    // Deletes go last, so a seeded record one removes is still there for the
    // operations that read or change it, and the deepest path first, so a
    // record goes before the record it sits under.
    const isDelete = (op: Operation) => op.kind === "http" && op.method === "DELETE";
    const depth = (op: Operation) => op.path.split("/").length;
    const ordered = [
      ...inScope.filter((op) => !isDelete(op)),
      ...inScope.filter(isDelete).sort((a, b) => depth(b) - depth(a)),
    ];
    for (const role of ["guardian", "teammate", "anonymous", "outsider"] as const) {
      byRole.set(role, await callAllAs(ordered, role, standIn));
    }
  }
  const outcomeOf = async (op: Operation, role: Role): Promise<Outcome> => {
    const recorded = byRole.get(role)?.get(op.route);
    return recorded ?? callOnFreshInstance(op, role, standIn);
  };

  const results: OperationResult[] = [];
  for (const op of operations) {
    const base = { route: op.route, path: op.path, kind: op.kind, reach: op.reach };
    if (!inScope.includes(op)) {
      results.push({ ...base, verdict: "out-of-scope", outcomes: {} });
      continue;
    }
    const guardian = await outcomeOf(op, "guardian");
    const teammate = await outcomeOf(op, "teammate");
    const exception = exceptions.get(op.route);
    const result: OperationResult = {
      ...base,
      verdict: exception ? "exception" : compare(guardian, teammate),
      ...(exception ? { exception } : {}),
      outcomes: { guardian, teammate },
    };
    if (!guardian.refused) {
      const anonymous = await outcomeOf(op, "anonymous");
      result.outcomes.anonymous = anonymous;
      if (anonymous.refused) {
        const outsider = await outcomeOf(op, "outsider");
        result.outcomes.outsider = outsider;
        result.outsider = outsider.refused ? "refused" : "admitted";
      }
    }
    results.push(result);
  }

  const routesWith = (verdict: Verdict) =>
    results.filter((r) => r.verdict === verdict).map((r) => r.route);
  const outsiderAdmitted = results.filter((r) => r.outsider === "admitted").map((r) => r.route);
  const drift = mountDrift();
  const teammateRefused = routesWith("teammate-refused");
  const statusDiffers = routesWith("status-differs");
  return {
    pass:
      teammateRefused.length === 0 &&
      statusDiffers.length === 0 &&
      outsiderAdmitted.length === 0 &&
      unclaimed.length === 0 &&
      drift.length === 0,
    operations: results,
    teammateRefused,
    statusDiffers,
    unverified: routesWith("unverified"),
    outsiderAdmitted,
    unclaimedUpgradeHandlers: unclaimed,
    mountDrift: drift,
    outOfScope: results
      .filter((r) => r.verdict === "out-of-scope")
      .map((r) => ({ route: r.route, reach: r.reach })),
  };
}
