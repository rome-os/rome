// Proves the verifier before the product exists: the good stand-in passes
// every rule, and each broken stand-in fails the rule it breaks.
// Run: node --test verifiers/ambient-agent/test/*.test.mjs

import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { up } from "../standin/up.mjs";

const verify = fileURLToPath(new URL("../verify.mjs", import.meta.url));
const all = (result) => Object.fromEntries([1, 2, 3, 4, 5, 6, 7, 8].map((n) => [n, result]));
const failing = (...rules) => ({
  ...all("pass"),
  ...Object.fromEntries(rules.map((n) => [n, "fail"])),
});

const CASES = [
  {
    name: "good",
    want: all("pass"),
    exit: 0,
    args: ["--runs", "3", "--bursts"],
    what: "three runs of rules 5 to 8, and the bursts",
  },
  {
    name: "last-chat",
    up: { breaks: "last-chat" },
    want: failing(5),
    exit: 1,
    what: "says a code back in the last chat that spoke",
  },
  {
    name: "same-answer",
    up: { breaks: "same-answer" },
    want: failing(6),
    exit: 1,
    what: "gives both members the same answer",
  },
  {
    name: "dm-in-shared",
    up: { breaks: "dm-in-shared" },
    want: failing(7),
    exit: 1,
    what: "answers a direct message in a shared chat",
  },
  {
    name: "result-latest",
    up: { breaks: "result-latest" },
    want: failing(8),
    exit: 1,
    what: "posts the result where the latest mention came from",
  },
  {
    name: "no-handoff",
    up: { breaks: "no-handoff" },
    want: failing(8),
    exit: 1,
    what: "does the work itself",
    reason: [8, /no hand-off in the instance's log/],
  },
  // Reads #general once at start, so a fact asked for anywhere later is lost.
  {
    name: "recall",
    up: { breaks: "recall" },
    want: failing(1, 6),
    exit: 1,
    what: "answers from a read made at start, never at the mention",
  },
  {
    name: "silence",
    up: { breaks: "silence" },
    want: failing(2),
    exit: 1,
    what: "answers an unmentioned message naming it",
  },
  {
    name: "stopped",
    up: { breaks: "stopped" },
    want: failing(3),
    exit: 1,
    what: "loses what was said while it was stopped",
  },
  {
    name: "kinds",
    up: { kinds: true },
    want: failing(4),
    exit: 1,
    what: "changes a file under connections/kinds/",
  },
  {
    name: "needs-more",
    up: { needsMore: true },
    want: failing(4),
    exit: 1,
    what: "its in-process test needs more than the three things",
  },
  {
    name: "no-history",
    up: { breaks: "no-history" },
    want: failing(1, 3, 6),
    exit: 1,
    what: "never reads the history",
    reason: [1, /10 answered without the fact.*guardian asked.*answered without the fact/],
  },
  {
    name: "guardian-only",
    up: { breaks: "guardian-only" },
    want: failing(1, 3, 5, 6, 7, 8),
    exit: 1,
    what: "answers only the guardian, as main",
    reason: [1, /did not answer a member's mention.*guardian asked.*held the fact/],
  },
  {
    name: "silent",
    up: { breaks: "silent" },
    want: all("not checked"),
    exit: 3,
    what: "never replies",
    fault: /agent not answering/,
  },
];

function runVerifier(envPath, out, args = ["--runs", "1"]) {
  return new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      [
        verify,
        ...[
          "--env",
          envPath,
          "--out",
          out,
          "--dirty",
          "--reply-seconds",
          "8",
          "--after-reply-seconds",
          "1",
        ],
        ...[
          "--settle-seconds",
          "6",
          "--pace-margin-ms",
          "200",
          "--work-seconds",
          "15",
          "--side-delay-seconds",
          "0.5",
        ],
        ...args,
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    let output = "";
    child.stdout.on("data", (d) => {
      output += d;
    });
    child.stderr.on("data", (d) => {
      output += d;
    });
    child.on("close", (code) => resolve({ code, output }));
  });
}

describe("the verifier on stand-ins", { concurrency: true }, () => {
  for (const c of CASES) {
    it(`${c.name}${c.what ? ` (${c.what})` : ""}`, { timeout: 1_800_000 }, async () => {
      const dir = mkdtempSync(join(tmpdir(), `ambient-proof-${c.name}-`));
      const env = await up(dir, c.up);
      let r;
      try {
        r = await runVerifier(env.envPath, join(dir, "out"), c.args);
      } finally {
        await env.down();
      }
      const report = JSON.parse(readFileSync(join(dir, "out/report.json"), "utf8"));
      const got = Object.fromEntries(Object.entries(report.rules).map(([n, x]) => [n, x.result]));
      assert.deepEqual(got, c.want, r.output);
      assert.equal(r.code, c.exit, r.output);
      if (c.fault) assert.match(report.fault, c.fault);
      if (c.reason) assert.match(report.rules[c.reason[0]].reason, c.reason[1]);
      assert.equal(report.rulesVersion, "V4");
      assert.ok(
        report.commits.product &&
          report.commits.verifier &&
          report.commits.environment &&
          report.model &&
          report.effort,
      );
      assert.ok(readFileSync(join(dir, "out/report.md"), "utf8").includes("rule set V4"));
      // The test file went back out of the product's checkout.
      assert.equal(execFileSync("git", ["-C", env.rome, "status", "--porcelain"]).toString(), "");
      if (c.name === "good") {
        const rounds = report.rules[1].evidence.rounds;
        assert.equal(rounds.length, 10);
        assert.ok(
          rounds.every((x) => x.otherMessages === 10 && x.replies.length > 0 && !x.askedByGuardian),
        );
        assert.equal(report.rules[1].evidence.guardianRoundNotCounted.askedByGuardian, true);
        assert.equal(report.rules[2].evidence.messages, 50);
        for (const n of [5, 6, 7, 8])
          assert.equal(report.rules[n].evidence.runs.length, 3, `rule ${n} runs`);
        assert.equal(report.rules[5].evidence.runs[0].evidence.asked, 50);
        assert.equal(report.rules[6].evidence.runs[0].evidence.pairs.length, 20);
        assert.equal(report.rules[7].evidence.runs[0].evidence.asked, 20);
        assert.ok(
          report.rules[8].evidence.runs[0].evidence.rounds.every(
            (x) => x.handedOff && x.othersBeforeResult,
          ),
        );
        assert.deepEqual(
          report.bursts.sizes.map((s) => [s.size, s.answered]),
          [
            [1, 1],
            [3, 3],
            [10, 10],
            [30, 30],
          ],
        );
        assert.equal(report.cost.cost_usd, 0);
      }
    });
  }
});
