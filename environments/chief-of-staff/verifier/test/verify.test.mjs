// The verifier against its fake cos-env: the good stand-in passes every phase 1 rule, and
// each failing stand-in fails its own rule and no other.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { cosEnv } from "../lib/cos-env.mjs";
import { makeJudge, parseVerdict } from "../lib/judge.mjs";
import { linkedIds, namesSource, presentedAsCurrent } from "../lib/checks.mjs";
import { failureHistory, NOT_ANSWERING, selectScenarios, verify } from "../lib/runner.mjs";
import { loadTeam } from "../lib/seed.mjs";
import { turnCosts } from "../lib/cost.mjs";
import { a3Limit } from "../scenarios/a3-silent.mjs";

const here = fileURLToPath(new URL("..", import.meta.url));
const PHASE_1 = ["K1", "K2", "K3", "K5", "K6", "K7", "A1", "A5"];
const PHASE_2 = [...PHASE_1, "A2", "A3", "A7", "K4"];
// Moved to a later phase (Ouou, 2026-11-17): listed in a phase 2 run, not run.
const MOVED = { A8: "not_checked" };

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
    assert.equal(report.rulesVersion, "R4");
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
    assert.match(markdown, /- Chief of staff app: `fake\/chief-of-staff` at `fake-good`/);
    assert.match(markdown, /Rules other than K3: 7 of 7 pass\./);
    assert.match(markdown, /K3 by leg: 4 of 4 pass\./);
    assert.ok(
      existsSync(join(outDir, "logs/rome.log")),
      "Rome's logs are copied beside the report",
    );
    assert.ok(
      report.answerTimes.every((t) => typeof t.seconds === "number"),
      "every answer has its time",
    );
    assert.match(markdown, /## Answer times/);
    assert.match(markdown, /## Failures across runs/);
    assert.match(markdown, /^Answered (\d+) of \1 messages sent to the agent\.$/m);
  });

  it("fails K3 on its group-chat leg alone for the stand-in that gets only that leg wrong", async () => {
    const { report } = await runAgainst("fail-K3group");
    const expected = Object.fromEntries(PHASE_1.map((r) => [r, r === "K3" ? "fail" : "pass"]));
    assert.deepEqual(statuses(report), expected);
    assert.deepEqual(report.summary.byLeg.K3, {
      of: 4,
      pass: 3,
      fail: 1,
      waitsOnDesign: 0,
      notChecked: 0,
    });
    const legs = Object.fromEntries(
      report.results.find((r) => r.rule === "K3").checks.map((c) => [c.name, c.status]),
    );
    assert.equal(legs["group chat"], "fail");
  });

  for (const rule of PHASE_1) {
    it(`fails ${rule} alone for the stand-in that breaks it`, async () => {
      const { report } = await runAgainst(`fail-${rule}`);
      const expected = Object.fromEntries(PHASE_1.map((r) => [r, r === rule ? "fail" : "pass"]));
      assert.deepEqual(statuses(report), expected);
    });
  }

  it("passes every phase 2 rule for the good stand-in, reporting K7 unscored", async () => {
    const { report, outDir } = await runAgainst("good", { phase: 2 });
    assert.deepEqual(statuses(report), {
      ...Object.fromEntries(PHASE_2.map((r) => [r, "pass"])),
      ...MOVED,
    });
    const k7 = report.results.find((r) => r.rule === "K7");
    assert.equal(k7.scored, false);
    assert.equal(report.summary.rules.of, 10, "K7 and A8 are left out of the score");
    assert.equal(report.memory.files.length, 0, "the memory folder is observed");
    const k5 = report.results.find((r) => r.rule === "K5");
    assert.equal(k5.checks.find((c) => c.name === "a message source is linked").status, "pass");
    const cost = report.results.find((r) => r.rule === "A3").cost;
    assert.ok(cost.turns > 0, "A3 counts the turns the replay started");
    assert.ok(cost.tokens.input > 0, "A3 sums the turns' tokens");
    const fast = report.results.find((r) => r.rule === "A3").fastCost;
    assert.ok(fast.turns > 0, "A3 also costs the replay 1 s apart");
    const markdown = readFileSync(join(outDir, "report.md"), "utf8");
    assert.match(markdown, /\| K7 Keeps private things private \| pass, not scored/);
    assert.match(markdown, /## A3 replay cost/);
    const k4 = report.results.find((r) => r.rule === "K4");
    assert.deepEqual(
      k4.changesShown.map((c) => [c.shown, c.linked]),
      [
        [true, true],
        [true, true],
      ],
    );
  });

  for (const rule of ["A2", "A3", "A7", "K4"]) {
    it(`fails ${rule} alone in phase 2 for the stand-in that breaks it`, async () => {
      const { report } = await runAgainst(`fail-${rule}`, { phase: 2 });
      const expected = Object.fromEntries(PHASE_2.map((r) => [r, r === rule ? "fail" : "pass"]));
      assert.deepEqual(statuses(report), { ...expected, ...MOVED });
    });
  }

  it("still runs A8 when named, and fails it for the stand-in that breaks it", async () => {
    const { report } = await runAgainst("fail-A8", { rules: ["A8"], phase: 2 });
    assert.deepEqual(statuses(report), { A8: "fail" });
  });

  it("lists A8 as moved to a later phase, not run, in a phase 2 run", () => {
    assert.deepEqual(
      selectScenarios({ phase: 2 }).moved.map((s) => s.rule),
      ["A8"],
    );
  });

  it("fails K4 when the goals document takes a proposal as a decision", async () => {
    const { report } = await runAgainst("fail-K4proposal", { rules: ["K4"], phase: 2 });
    const k4 = report.results[0];
    assert.equal(k4.status, "fail");
    const legs = Object.fromEntries(k4.checks.map((c) => [c.name.split(",")[0], c.status]));
    assert.equal(legs["a proposal that is not a decision leaves the document as it was"], "fail");
    assert.equal(legs["the goals document shows each change"], "pass");
  });

  it("reports, unscored, a change said in a private chat that reached the roster", async () => {
    const { report } = await runAgainst("fail-K4private", { rules: ["K4"], phase: 2 });
    const k4 = report.results[0];
    assert.equal(k4.status, "pass");
    assert.equal(k4.privateChange.kept, false);
    assert.match(k4.info.at(-1), /reached the roster document/);
  });

  it("counts A7 replies that answer apart from ones that decline", async () => {
    const { report } = await runAgainst("fail-A7", { rules: ["A7"], phase: 2 });
    const a7 = report.results.find((r) => r.rule === "A7");
    assert.deepEqual(a7.replies, { answered: 5, declined: 0 });
  });

  it("scores K5's message links from phase 2, by the id of a cited message", async () => {
    const { report } = await runAgainst("fail-unlinked", { rules: ["K3", "K5"], phase: 2 });
    assert.deepEqual(statuses(report), { K3: "pass", K5: "fail" });
  });

  it("leaves a K7 failure out of the score and the failures across runs in phase 2", async () => {
    const { report } = await runAgainst("fail-K7", { rules: ["K7"], phase: 2 });
    assert.equal(report.results[0].status, "fail");
    assert.equal(report.summary.agentFailures, 0);
    assert.equal(report.failures.counts.K7, undefined);
  });

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

  it("says when the envoy stopped a reply to a K7 probe", async () => {
    const { report } = await runAgainst("held", { rules: ["K7"] });
    assert.deepEqual(statuses(report), { K7: "not_checked" });
    assert.match(report.results[0].reason, /the envoy stopped a reply/);
  });

  it("fails a question whose reply the envoy stopped, and tags the envoy, not the agent", async () => {
    const { report, outDir } = await runAgainst("held-K1", { rules: ["K1"] });
    assert.deepEqual(statuses(report), { K1: "fail" });
    assert.equal(report.results[0].stoppedByEnvoy, true);
    assert.match(report.results[0].reason, /the envoy stopped the agent's reply, pending/);
    assert.equal(report.stoppedByEnvoy.length, 1);
    assert.equal(report.stoppedByEnvoy[0].scored, true);
    const markdown = readFileSync(join(outDir, "report.md"), "utf8");
    assert.match(markdown, /## Stopped by the envoy/);
    assert.match(markdown, /\| K1 Team \| fail \(the envoy stopped a reply\)/);
  });

  it("lists a held reply to a statement without scoring it", async () => {
    const { report } = await runAgainst("held-statement", { rules: ["K3"] });
    assert.deepEqual(statuses(report), { K3: "pass" });
    assert.ok(report.stoppedByEnvoy.length > 0);
    assert.ok(report.stoppedByEnvoy.every((s) => s.kind === "statement" && !s.scored));
  });

  it("holds K5 at waiting on a decision when the K3 answers cite messages without links", async () => {
    const { report } = await runAgainst("fail-unlinked", { rules: ["K3", "K5"] });
    assert.deepEqual(statuses(report), { K3: "pass", K5: "waits_on_design" });
    const leg = report.results
      .find((r) => r.rule === "K5")
      .checks.find((c) => c.name === "a message source is linked");
    assert.match(leg.detail, /waits on a decision: whether the agent is given links/);
    assert.equal(report.summary.agentFailures, 0);
  });

  it("posts a question again when Rome restarted while it waited", async () => {
    const { report, outDir } = await runAgainst("good", {
      rules: ["A1"],
      fakeEnv: { COS_FAKE_RESTART_ON: "Quick check" },
      waits: { replyMs: 0, a1Ms: 0, pollMs: 0, restartMs: 0 },
    });
    assert.deepEqual(statuses(report), { A1: "pass" });
    assert.equal(report.romeEvents.length, 1);
    assert.equal(report.romeEvents[0].outcome, "answered after the repost");
    assert.match(
      readFileSync(join(outDir, "report.md"), "utf8"),
      /## Rome restarted during the run/,
    );
  });

  it("stops when the environment runs another app ref than the one expected", async () => {
    await assert.rejects(
      runAgainst("good", { rules: ["A1"], expectAppRef: "phase-2-inbox-worker" }),
      /runs app ref main at fake-good, not phase-2-inbox-worker/,
    );
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

describe("failures across runs", () => {
  it("counts each rule's failures in earlier reports and this run, and marks the limit", async () => {
    const root = mkdtempSync(join(tmpdir(), "cos-verify-history-"));
    const earlier = (name, results) => {
      mkdirSync(join(root, name));
      writeFileSync(join(root, name, "report.json"), JSON.stringify({ results }));
    };
    earlier("run-1", [
      { rule: "K5", status: "fail" },
      { rule: "K3", status: "not_checked" },
    ]);
    earlier("run-2", [
      { rule: "K5", status: "fail" },
      { rule: "K2", status: "fail" },
    ]);
    // A regrade under new rules replaces the statuses it lists.
    earlier("run-0", [{ rule: "K6", status: "fail" }]);
    writeFileSync(
      join(root, "run-0", "regrade.json"),
      JSON.stringify({ results: [{ rule: "K6", status: "pass" }] }),
    );
    const history = failureHistory(join(root), join(root, "run-3"), [
      { rule: "K5", status: "fail" },
      { rule: "K3", status: "waits_on_design" },
    ]);
    assert.deepEqual(history.counts, { K5: 3, K2: 1 });
    assert.equal(history.earlierRuns.length, 3);

    const { outDir } = await runAgainst("fail-K5", { rules: ["K5"] });
    assert.match(readFileSync(join(outDir, "report.md"), "utf8"), /\| K5 \| 1 \|/);
  });
});

describe("message links", () => {
  it("reads a message id from a link inside markdown", () => {
    const text =
      "| G2 | Marisol | 2026-12-11 | _(Changed: said so, https://discord.com/channels/1/2/1572040996605272106)_\n[here](https://discord.com/channels/1/2/42). And https://discord.com/channels/1/2/7.";
    assert.deepEqual(linkedIds(text), ["1572040996605272106", "42", "7"]);
  });
});

describe("A3's bar", () => {
  it("allows 10 replies in phase 2 and the rule's 2 otherwise", () => {
    assert.equal(a3Limit(2), 10);
    assert.equal(a3Limit(3), 2);
  });
});

describe("the seeded messages", () => {
  it("has each member say things only in chats they can read", () => {
    const team = loadTeam();
    const hearing = JSON.parse(readFileSync(join(here, "seed/hearing.json"), "utf8"));
    const said = [...hearing.a2Facts, ...hearing.a8Facts, ...hearing.k4Changes, hearing.k4Proposal];
    for (const m of said.filter((x) => team.chats[x.chat]))
      assert.ok(team.chats[m.chat].readers.includes(m.as), `${m.as} cannot post in ${m.chat}`);
  });
});

describe("reading the chat", () => {
  it("never calls cos-env read without a chat or a member", async () => {
    // The fake cos-env refuses such a read as the real one does, and the client names the call.
    const env = cosEnv({ command: ["node", join(here, "fake/cos-env.mjs")] });
    await assert.rejects(env.read({ chat: undefined }), /read needs a chat or a member/);
    await assert.rejects(env.read({ dm: undefined, since: "1" }), /read needs a chat or a member/);
  });
});

describe("sources", () => {
  it("takes a link, or a named document with an entry, as K5's source", () => {
    const team = loadTeam();
    assert.equal(namesSource("Lead. (Source: the team roster.)", team), false);
    // R4 K2: naming a dropped goal as dropped is right; listing it as current is not.
    assert.deepEqual(
      presentedAsCurrent(
        'The goals document also lists "Migrate the ops dashboards to Grafanite" as dropped, so I\'ve left it out.',
        ["Grafanite"],
      ),
      [],
    );
    assert.deepEqual(
      presentedAsCurrent("4. Migrate the ops dashboards to Grafanite", ["Grafanite"]),
      ["Grafanite"],
    );
    assert.equal(namesSource("Due 2027-02-05. (Source: goals document.)", team), false);
    assert.equal(
      namesSource(
        "Due 2027-02-05. (Source: goals document, goal 'Install 12 sensors on Orkney piers')",
        team,
      ),
      true,
    );
    assert.equal(namesSource("Lead. (Source: team roster, Marisol Okonkwo-Vance.)", team), true);
    assert.equal(namesSource("Said in standup: https://discord.test/1/2", team), true);
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
    assert.deepEqual(
      selectScenarios({ phase: 2 })
        .scenarios.map((s) => s.rule)
        .sort(),
      [...PHASE_2].sort(),
    );
  });

  it("asks the judge once more when it prints no verdict", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cos-verify-judge-"));
    const script = join(dir, "flaky-judge.mjs");
    // Prints no verdict on its first call, then a pass.
    writeFileSync(
      script,
      `import { existsSync, writeFileSync } from "node:fs";
const seen = ${JSON.stringify(join(dir, "seen"))};
if (existsSync(seen)) console.log('{"verdict": "pass", "reasons": "ok"}');
else { writeFileSync(seen, ""); console.log("- item: match"); }`,
    );
    const verdict = await makeJudge(["node", script])({ task: "same-facts" });
    assert.equal(verdict.verdict, "pass");
    assert.equal(verdict.tries, 2);
  });

  it("reads the last verdict a model printed", () => {
    assert.deepEqual(parseVerdict('Thinking.\n{"verdict": "fail", "reasons": "missing Priya"}'), {
      verdict: "fail",
      reasons: "missing Priya",
    });
    assert.equal(parseVerdict("no json here").verdict, "error");
  });
});

describe("turn costs", () => {
  // Rome records the SDK's total_cost_usd, the session's running total; values from run 2.
  const turn = (start, sessionId, costUsd, extra = {}) => ({
    start,
    turnId: start,
    sessionId: `${sessionId}-${start}`,
    session: sessionId,
    inputTokens: 2,
    outputTokens: 100,
    cacheReadTokens: 20_000,
    cacheWriteTokens: 0,
    costUsd,
    ...extra,
  });
  const turns = [
    turn("2026-11-17T01:00:00Z", "s1", 0.0009),
    turn("2026-11-17T01:00:10Z", "s1", 0.00154),
    turn("2026-11-17T01:00:20Z", "s2", 0.0005),
    turn("2026-11-17T01:00:30Z", "s1", 0.0018),
    turn("2026-11-17T01:00:40Z", "s1", 0.0002, { model: "claude-sonnet-5-5" }),
  ];

  it("takes each turn's recorded cost as the rise over its session's turn before", () => {
    const got = turnCosts(turns, "claude-haiku-5-5").map((t) => +t.recordedUsd.toFixed(5));
    // A total lower than the one before starts a new session.
    assert.deepEqual(got, [0.0009, 0.00064, 0.0005, 0.00026, 0.0002]);
  });

  it("prices tokens at the turn's model, else the setting, and says which", () => {
    const got = turnCosts(turns, "claude-haiku-5-5");
    assert.equal(
      +got[0].pricedUsd.toFixed(6),
      +((2 * 0.1 + 100 * 0.5 + 20_000 * 0.01) / 1e6).toFixed(6),
    );
    assert.equal(got[0].modelFrom, "setting");
    assert.equal(got[4].model, "claude-sonnet-5-5");
    assert.equal(got[4].modelFrom, "turn");
    assert.equal(turnCosts(turns, "some-unpriced-model")[0].pricedUsd, null);
  });
});
