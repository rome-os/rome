// The verifier proven against stand-in products whose verdicts never change,
// whatever state the product in the tree is in: one with a route only the
// guardian may call, which must fail rule 2 naming that route; one where every
// check admits the teammate as it admits the guardian, which must pass; one
// that admits a visitor nobody invited, which must fail; and one whose sign-in
// hands an uninvited account the guardian's session, which must fail rule 1;
// and one where the guardian's save keeps the teammate on the list, which must
// fail the removal check with every socket it could check still open.

import { describe, expect, it } from "@rstest/core";
import { runRule1b } from "./rule1.js";
import { runRule2, STAND_IN_GUARDIAN_ONLY_ROUTE, type Rule2Result } from "./rule2.js";
import { runRule3Dashboard } from "./rule3.js";
import { writePart } from "./report.js";

const summary = (result: Rule2Result) => ({
  pass: result.pass,
  teammateRefused: result.teammateRefused,
  statusDiffers: result.statusDiffers,
  outsiderAdmitted: result.outsiderAdmitted,
  unclaimedUpgradeHandlers: result.unclaimedUpgradeHandlers,
  mountDrift: result.mountDrift,
});

const proofs: Record<string, unknown> = {};

describe("the rule 2 verifier", () => {
  it("fails a stand-in with a route only the guardian may call, naming that route", async () => {
    const result = await runRule2({ standIn: "guardian-only-route" });
    proofs.guardianOnlyRoute = summary(result);
    writePart("proofs", proofs);
    expect(result.pass).toBe(false);
    expect(result.teammateRefused).toContain(STAND_IN_GUARDIAN_ONLY_ROUTE);
  }, 600_000);

  it("passes a stand-in whose checks admit the teammate as they admit the guardian", async () => {
    const result = await runRule2({ standIn: "open-checks" });
    proofs.openChecks = summary(result);
    writePart("proofs", proofs);
    expect(result.teammateRefused).toEqual([]);
    expect(result.statusDiffers).toEqual([]);
    expect(result.outsiderAdmitted).toEqual([]);
    expect(result.pass).toBe(true);
  }, 600_000);

  it("fails a stand-in that admits a visitor nobody put on the list", async () => {
    const result = await runRule2({ standIn: "admit-every-visitor" });
    proofs.admitEveryVisitor = summary(result);
    writePart("proofs", proofs);
    expect(result.pass).toBe(false);
    expect(result.outsiderAdmitted).toEqual(
      expect.arrayContaining(["GET /api/chat/sessions", "GET /api/settings"]),
    );
  }, 600_000);
});

describe("the rule 1 sign-in check", () => {
  it("fails a stand-in whose sign-in hands an uninvited account the guardian's session", async () => {
    const result = await runRule1b({ standIn: "guardian-session-for-everyone" });
    proofs.guardianSessionForEveryone = { pass: result.pass, uninvited: result.uninvited };
    writePart("proofs", proofs);
    expect(result.pass).toBe(false);
    expect(result.uninvited.at(-1)?.ok).toBe(false);
  }, 60_000);
});

describe("the removal check", () => {
  it("fails a stand-in whose save keeps the teammate on the list", async () => {
    const result = await runRule3Dashboard({ standIn: "teammate-kept" });
    proofs.teammateKept = result;
    writePart("proofs", proofs);
    expect(result.pass).toBe(false);
    const checked = result.sockets.filter((s) => s.verdict !== "unverified");
    expect(checked.map((s) => s.route)).toEqual(
      expect.arrayContaining(["WS /ws/events", "WS /ws/voice-conversation"]),
    );
    expect(checked.every((s) => s.verdict === "open")).toBe(true);
    expect(result.nextCall.refused).toBe(false);
  }, 120_000);
});
