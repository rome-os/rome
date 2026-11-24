// Rule 2 of "a team can share one Rome" as a check CI runs (`pnpm test:e2e`):
// no visitor nobody invited is admitted, a teammate fails to reach what the
// guardian reaches only on the routes in known-failures.json, and the routes
// the check cannot verify are the ones in unverified.json. It runs every
// operation on one instance per role; run.sh gives every call its own
// instance and writes the full report.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "@rstest/core";
import { runRule1b } from "./rule1.js";
import { runRule2, type Rule2Result } from "./rule2.js";
import {
  STAND_IN_GUARDIAN_ONLY_ROUTE,
  STAND_IN_GUARDIAN_ONLY_WRITE,
  STAND_IN_VALIDATES_FIRST,
} from "./stand-in-routes.js";

function routesIn(file: "known-failures.json" | "unverified.json"): string[] {
  const parsed = JSON.parse(
    readFileSync(join(process.cwd(), "src", "test", "team", file), "utf8"),
  ) as { routes: string[] };
  return parsed.routes;
}

const knownFailures = () => routesIn("known-failures.json");

/** The routes where the teammate does not reach what the guardian reaches. */
const failing = (result: Rule2Result) =>
  [...result.teammateRefused, ...result.statusDiffers].sort();

describe("a teammate on the dashboard", () => {
  it("fails to reach what the guardian reaches only where known-failures.json says", async () => {
    const result = await runRule2({ isolation: "per-role" });
    expect(result.outsiderAdmitted).toEqual([]);
    expect(failing(result)).toEqual([...knownFailures()].sort());
    expect([...result.unverified].sort()).toEqual([...routesIn("unverified.json")].sort());
    expect(result.mountDrift).toEqual([]);
    expect(result.unclaimedUpgradeHandlers).toEqual([]);
  }, 120_000);

  it("signs in when invited, and an account nobody invited gets no session", async () => {
    const result = await runRule1b();
    expect(result.uninvited.filter((step) => !step.ok)).toEqual([]);
    expect(result.invited.filter((step) => !step.ok)).toEqual([]);
  }, 60_000);
});

describe("the check", () => {
  it("fails on a new route only the guardian may call", async () => {
    const result = await runRule2({ isolation: "per-role", standIn: "guardian-only-route" });
    const known = knownFailures();
    expect(failing(result).filter((route) => !known.includes(route))).toEqual([
      STAND_IN_GUARDIAN_ONLY_ROUTE,
      STAND_IN_GUARDIAN_ONLY_WRITE,
    ]);
    // The same route, called without a body it accepts, gets 400 for both
    // callers and leaves the routes the check verifies.
    const unverified = routesIn("unverified.json");
    expect(result.unverified.filter((route) => !unverified.includes(route))).toEqual([
      STAND_IN_VALIDATES_FIRST,
    ]);
  }, 120_000);

  it("fails when a visitor nobody invited is admitted", async () => {
    const result = await runRule2({ isolation: "per-role", standIn: "admit-every-visitor" });
    expect(result.outsiderAdmitted).toEqual(
      expect.arrayContaining(["GET /api/chat/sessions", "GET /api/settings"]),
    );
  }, 120_000);

  it("fails when sign-in hands an account nobody invited the guardian's session", async () => {
    const result = await runRule1b({ standIn: "guardian-session-for-everyone" });
    expect(result.uninvited.at(-1)?.ok).toBe(false);
  }, 60_000);
});
