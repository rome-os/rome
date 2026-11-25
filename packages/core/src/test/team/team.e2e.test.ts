// Rule 2 of "a team can share one Rome" as a check CI runs (`pnpm test:e2e`):
// every operation refuses a signed-out caller and a visitor nobody invited
// unless public.json names it, a teammate fails to reach what the guardian
// reaches only on the routes in known-failures.json, and the routes the check
// cannot verify are the ones in unverified.json. run.sh runs the same check
// and writes the full report.

// First, so HOME is the sandbox's before any product module loads.
import { SANDBOX } from "./sandbox.js";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "@rstest/core";
import { runRule1b } from "./rule1.js";
import { runRule2, type Rule2Result } from "./rule2.js";
import { runRule3Dashboard } from "./rule3.js";
import {
  STAND_IN_GUARDIAN_ONLY_ROUTE,
  STAND_IN_GUARDIAN_ONLY_WRITE,
  STAND_IN_OPEN_SOCKET_PATH,
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

// The marker `DELETE /api/ai-tools/anthropic-compatible-credentials` clears
// when a stored credential was refused. It sits in `~/.claude`, as
// `refused-credential.ts` read HOME when it loaded.
const revokedMarker = (home: string) => join(home, ".claude", ".rome-auth-revoked.json");

function plantRevokedMarker(home: string): void {
  mkdirSync(join(home, ".claude"), { recursive: true });
  writeFileSync(
    revokedMarker(home),
    JSON.stringify({
      source: { type: "stored-compatible", provider: "custom", apiKeyHash: "team-verifier" },
      detectedAt: new Date(0).toISOString(),
    }),
  );
}

describe("a teammate on the dashboard", () => {
  it("fails to reach what the guardian reaches only where known-failures.json says", async () => {
    plantRevokedMarker(SANDBOX.home);
    const originalMarker = SANDBOX.originalHome ? revokedMarker(SANDBOX.originalHome) : null;
    const originalHad = originalMarker ? existsSync(originalMarker) : false;

    const result = await runRule2();
    expect(result.anonymousAdmitted).toEqual([]);
    expect(result.outsiderAdmitted).toEqual([]);
    expect(result.stalePublic).toEqual([]);
    expect(result.refusedLaunches).toEqual([]);
    expect(failing(result)).toEqual([...knownFailures()].sort());
    expect([...result.unverified].sort()).toEqual([...routesIn("unverified.json")].sort());
    expect(result.mountDrift).toEqual([]);
    expect(result.unclaimedUpgradeHandlers).toEqual([]);

    // The sweep's delete cleared the sandbox's marker, so the product reads
    // `~/.claude` in the sandbox, and left the developer's home as it was.
    expect(existsSync(revokedMarker(SANDBOX.home))).toBe(false);
    if (originalMarker) expect(existsSync(originalMarker)).toBe(originalHad);
  }, 120_000);

  it("signs in when invited, and an account nobody invited gets no session", async () => {
    const result = await runRule1b();
    expect(result.uninvited.filter((step) => !step.ok)).toEqual([]);
    expect(result.invited.filter((step) => !step.ok)).toEqual([]);
  }, 60_000);
});

describe("the check", () => {
  it("fails on a new route only the guardian may call", async () => {
    const result = await runRule2({ standIn: "guardian-only-route" });
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

  it("passes a product whose checks admit the teammate as they admit the guardian", async () => {
    const result = await runRule2({ standIn: "open-checks" });
    expect(result.teammateRefused).toEqual([]);
    expect(result.statusDiffers).toEqual([]);
    expect(result.pass).toBe(true);
  }, 120_000);

  it("fails when a visitor nobody invited is admitted", async () => {
    const result = await runRule2({ standIn: "admit-every-visitor" });
    expect(result.outsiderAdmitted).toEqual(
      expect.arrayContaining(["GET /api/chat/sessions", "GET /api/settings"]),
    );
  }, 120_000);

  it("fails when an operation admits a signed-out caller", async () => {
    const result = await runRule2({ standIn: "open-socket" });
    expect(result.anonymousAdmitted).toEqual([`WS ${STAND_IN_OPEN_SOCKET_PATH}`]);
    expect(result.outsiderAdmitted).toEqual([`WS ${STAND_IN_OPEN_SOCKET_PATH}`]);
  }, 120_000);

  it("fails when sign-in hands an account nobody invited the guardian's session", async () => {
    const result = await runRule1b({ standIn: "guardian-session-for-everyone" });
    expect(result.uninvited.at(-1)?.ok).toBe(false);
  }, 60_000);
});

describe("the removal check", () => {
  it("fails a stand-in whose save keeps the member on the list", async () => {
    const result = await runRule3Dashboard({ standIn: "teammate-kept" });
    expect(result.pass).toBe(false);
    const checked = result.sockets.filter((s) => s.verdict !== "unverified");
    expect(checked.map((s) => s.route)).toEqual(
      expect.arrayContaining(["WS /ws/events", "WS /ws/voice-conversation"]),
    );
    expect(checked.every((s) => s.verdict === "open")).toBe(true);
    expect(checked.every((s) => s.newConnection?.refused === false)).toBe(true);
    expect(result.nextCall.refused).toBe(false);
  }, 120_000);
});
