// Rule 2: every dashboard operation, called once as the guardian and once as a
// teammate on instances in the same state, comes to the same outcome. Also: a
// visitor not on the dashboard list stays refused wherever the guardian is
// admitted and a signed-out caller is not.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createInstance, mountDrift, OUTSIDER, TEAMMATE, type Instance } from "./instance.js";
import {
  callHttp,
  callUpgrade,
  unclaimedUpgradeHandlers,
  type Outcome,
  type Role,
} from "./callers.js";
import { httpOperations, upgradeOperations, type Operation } from "./surface.js";

/**
 * A product the verifier is proven against instead of the one in the tree.
 * "open-checks": the teammate's calls carry the guardian's session, so every
 * check admits them as it admits the guardian. "admit-every-visitor": the
 * outsider's email is on the dashboard list too, so the product admits a
 * visitor nobody invited.
 */
export type StandIn = "open-checks" | "admit-every-visitor";

export interface Rule2Options {
  standIn?: StandIn;
}

export type Verdict =
  | "match"
  | "teammate-refused"
  | "status-differs"
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

function dashboardEmails(standIn: StandIn | undefined): string[] {
  return standIn === "admit-every-visitor" ? [TEAMMATE.email, OUTSIDER.email] : [TEAMMATE.email];
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
  const instance = await createInstance({ dashboardEmails: dashboardEmails(standIn) });
  try {
    return await run(instance);
  } finally {
    await instance.close();
  }
}

async function call(op: Operation, role: Role, standIn: StandIn | undefined): Promise<Outcome> {
  return onFreshInstance(standIn, async (instance) => {
    const as = sessionRole(role, standIn);
    if (op.kind === "http") {
      // Parameters are filled per instance, from that instance's seeded ids.
      const fresh = httpOperations(instance.app, instance.ids).find((o) => o.route === op.route);
      return callHttp(instance.app, fresh ?? op, as);
    }
    const listening = await instance.listen();
    try {
      return await callUpgrade(instance.app, listening.port, op, as);
    } finally {
      await listening.close();
    }
  });
}

function compare(guardian: Outcome, teammate: Outcome): Verdict {
  if (!guardian.refused && teammate.refused) return "teammate-refused";
  if (guardian.status !== teammate.status) return "status-differs";
  return "match";
}

export async function runRule2(options: Rule2Options = {}): Promise<Rule2Result> {
  const { standIn } = options;
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

  const results: OperationResult[] = [];
  for (const op of operations) {
    const base = { route: op.route, path: op.path, kind: op.kind, reach: op.reach };
    if (op.reach === "machine" || op.reach === "loopback-only") {
      results.push({ ...base, verdict: "out-of-scope", outcomes: {} });
      continue;
    }
    const guardian = await call(op, "guardian", standIn);
    const teammate = await call(op, "teammate", standIn);
    const exception = exceptions.get(op.route);
    const result: OperationResult = {
      ...base,
      verdict: exception ? "exception" : compare(guardian, teammate),
      ...(exception ? { exception } : {}),
      outcomes: { guardian, teammate },
    };
    if (!guardian.refused) {
      const anonymous = await call(op, "anonymous", standIn);
      result.outcomes.anonymous = anonymous;
      if (anonymous.refused) {
        const outsider = await call(op, "outsider", standIn);
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
    outsiderAdmitted,
    unclaimedUpgradeHandlers: unclaimed,
    mountDrift: drift,
    outOfScope: results
      .filter((r) => r.verdict === "out-of-scope")
      .map((r) => ({ route: r.route, reach: r.reach })),
  };
}
