// The verifier proven against products whose verdicts are known: the product
// in the tree, where the guardian-only checks must fail rule 2 by name; a
// stand-in where every check admits the teammate, which must pass; and a
// stand-in that admits a visitor nobody invited, which must fail.

import { describe, expect, it } from "@rstest/core";
import { runRule2, type Rule2Result } from "./rule2.js";
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
  it("fails the product in the tree on its guardian-only routes", async () => {
    const result = await runRule2();
    proofs.productInTree = summary(result);
    writePart("proofs", proofs);
    expect(result.pass).toBe(false);
    expect(result.teammateRefused).toEqual(
      expect.arrayContaining([
        "GET /api/approvals",
        "POST /api/approvals/:id/approve",
        "GET /api/vault",
        "PUT /api/vault/:name",
      ]),
    );
    expect(result.outsiderAdmitted).toEqual([]);
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
