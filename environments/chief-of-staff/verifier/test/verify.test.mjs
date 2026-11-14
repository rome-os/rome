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
import { NOT_ANSWERING, selectScenarios, verify } from "../lib/runner.mjs";

const here = fileURLToPath(new URL("..", import.meta.url));
const PHASE_1 = ["K1", "K2", "K3", "K5", "K6", "K7", "A1", "A5"];

async function runAgainst(agent, options = {}) {
  const { fakeEnv = {}, ...verifyOptions } = options;
  const dir = mkdtempSync(join(tmpdir(), `cos-verify-${agent}-`));
  const env = cosEnv({
    command: ["node", join(here, "fake/cos-env.mjs")],
    env: {
      ...process.env,
      COS_FAKE_STATE: join(dir, "state.json"),
      COS_FAKE_AGENT: agent,
      ...fakeEnv,
    },
  });
  return verify({
    env,
    judge: makeJudge(["node", join(here, "fake/judge.mjs")]),
    judgeName: "fake judge",
    waits: { replyMs: 0, a1Ms: 0, pollMs: 0 },
    allowDirty: true,
    outDir: join(dir, "run"),
    log: () => {},
    ...verifyOptions,
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
    assert.deepEqual(report.summary.rules, {
      of: 7,
      pass: 7,
      fail: 0,
      waitsOnDesign: 0,
      notChecked: 0,
    });
    assert.deepEqual(report.summary.byLeg.K3, {
      of: 4,
      pass: 4,
      fail: 0,
      waitsOnDesign: 0,
      notChecked: 0,
    });
    const markdown = readFileSync(join(outDir, "report.md"), "utf8");
    assert.match(markdown, /\| K1 Team \| pass/);
    assert.match(markdown, /Rules other than K3: 7 of 7 pass\./);
    assert.match(markdown, /K3 by leg: 4 of 4 pass\./);
    assert.match(markdown, /^Answered (\d+) of \1 messages sent to the agent\.$/m);
  });

  it("reports a group-chat attribution failure as waiting on a design decision", async () => {
    const { report, outDir } = await runAgainst("fail-K3group");
    const expected = Object.fromEntries(
      PHASE_1.map((r) => [r, r === "K3" ? "waits_on_design" : "pass"]),
    );
    assert.deepEqual(statuses(report), expected);
    assert.deepEqual(report.summary.byLeg.K3, {
      of: 4,
      pass: 3,
      fail: 0,
      waitsOnDesign: 1,
      notChecked: 0,
    });
    assert.equal(report.summary.agentFailures, 0);
    const legs = Object.fromEntries(
      report.results.find((r) => r.rule === "K3").checks.map((c) => [c.name, c.status]),
    );
    assert.equal(legs["group chat"], "waits_on_design");
    assert.match(
      readFileSync(join(outDir, "report.md"), "utf8"),
      /## Waiting on a design decision/,
    );
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

  it("holds K3 and K6 at not checked when a required leg cannot run", async () => {
    const { report } = await runAgainst("good", {
      rules: ["K3", "K6"],
      fakeEnv: { COS_FAKE_NO_SECOND_ACCOUNT: "1", COS_FAKE_NO_RENEW: "1" },
    });
    // Both have legs that pass, so a rule that only reported those would count as passed.
    // The unavailable leg is required, so neither rule passes.
    assert.deepEqual(statuses(report), { K3: "not_checked", K6: "not_checked" });
    const k3 = report.results.find((r) => r.rule === "K3");
    assert.match(k3.reason, /second account/);
    assert.ok(
      ["single-member chat", "group chat", "changed display name"].every((leg) =>
        k3.checks.some((c) => c.name === leg && c.status === "pass"),
      ),
      "the other three legs still passed",
    );
  });

  it("stops and scores nothing when the agent does not answer the opening mention", async () => {
    const { report, outDir } = await runAgainst("silent");
    assert.equal(report.stopped, NOT_ANSWERING);
    assert.deepEqual(report.results, []);
    assert.deepEqual(report.answered, { sent: 1, answered: 0 });
    assert.match(
      readFileSync(join(outDir, "report.md"), "utf8"),
      /Answered 0 of 1 messages sent to the agent\.\n\nStopped: agent not answering/,
    );
  });

  it("does not pass a check that only finds nothing wrong when the agent answered nothing", async () => {
    // The quiet stand-in answers the opening mention and nothing after it.
    const { report } = await runAgainst("quiet", { rules: ["K5", "K7", "A5"] });
    const s = statuses(report);
    assert.equal(s.K7, "not_checked");
    assert.equal(s.A5, "not_checked");
    const k5 = report.results.find((r) => r.rule === "K5");
    assert.equal(k5.checks.find((c) => c.name === "zero invented answers").status, "not_checked");
    assert.equal(report.answered.answered, 1);
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
