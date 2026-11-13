// The verifier against its fake cos-env: the good stand-in passes every phase 1 rule, and
// each failing stand-in fails its own rule and no other.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { cosEnv } from "../lib/cos-env.mjs";
import { makeJudge, parseVerdict } from "../lib/judge.mjs";
import { selectScenarios, verify } from "../lib/runner.mjs";

const here = fileURLToPath(new URL("..", import.meta.url));
const PHASE_1 = ["K1", "K2", "K3", "K5", "K6", "K7", "A1", "A5"];

async function runAgainst(agent, options = {}) {
  const dir = mkdtempSync(join(tmpdir(), `cos-verify-${agent}-`));
  const env = cosEnv({
    command: ["node", join(here, "fake/cos-env.mjs")],
    env: { ...process.env, COS_FAKE_STATE: join(dir, "state.json"), COS_FAKE_AGENT: agent },
  });
  return verify({
    env,
    judge: makeJudge(["node", join(here, "fake/judge.mjs")]),
    judgeName: "fake judge",
    waits: { replyMs: 0, a1Ms: 0, pollMs: 0 },
    allowDirty: true,
    outDir: join(dir, "run"),
    log: () => {},
    ...options,
  });
}

const statuses = (report) => Object.fromEntries(report.results.map((r) => [r.rule, r.status]));

describe("verify against the stand-in agents", { concurrency: true }, () => {
  it("passes every phase 1 rule for the good stand-in", async () => {
    const { report, outDir } = await runAgainst("good");
    assert.deepEqual(statuses(report), Object.fromEntries(PHASE_1.map((r) => [r, "pass"])));
    assert.equal(report.rulesVersion, "R2");
    assert.equal(report.underTest.agent.commit, "fake-good");
    assert.ok(
      report.results.every((r) => r.evidence.length > 0),
      "every rule names evidence",
    );
    assert.match(readFileSync(join(outDir, "report.md"), "utf8"), /\| K1 Team \| pass/);
  });

  for (const rule of PHASE_1) {
    it(`fails ${rule} alone for the stand-in that breaks it`, async () => {
      const { report } = await runAgainst(`fail-${rule}`);
      const expected = Object.fromEntries(PHASE_1.map((r) => [r, r === rule ? "fail" : "pass"]));
      assert.deepEqual(statuses(report), expected);
    });
  }

  it("runs only the rules asked for, and reports an unknown rule as not checked", async () => {
    const { report } = await runAgainst("good", { rules: ["A5", "P1"] });
    assert.deepEqual(statuses(report), { A5: "pass", P1: "not_checked" });
  });

  it("refuses a dirty tree unless allowed", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cos-verify-dirty-"));
    const env = {
      ...cosEnv({ command: ["true"] }),
      version: async () => ({ agent: { commit: "abc", dirty: true } }),
    };
    await assert.rejects(
      verify({
        env,
        judge: async () => ({}),
        waits: {},
        allowDirty: false,
        outDir: dir,
        log: () => {},
      }),
      /uncommitted changes in agent/,
    );
  });
});

describe("selection and parsing", () => {
  it("selects a phase's rules", () => {
    assert.deepEqual(
      selectScenarios({ phase: 1 })
        .scenarios.map((s) => s.rule)
        .sort(),
      [...PHASE_1].sort(),
    );
  });

  it("reads the last verdict a model printed", () => {
    assert.deepEqual(parseVerdict('Thinking.\n{"verdict": "fail", "reasons": "missing Priya"}'), {
      verdict: "fail",
      reasons: "missing Priya",
    });
    assert.equal(parseVerdict("no json here").verdict, "error");
  });
});
