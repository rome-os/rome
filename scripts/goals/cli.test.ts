import { describe, expect, it } from "@rstest/core";
import { join } from "node:path";
import { checkJson, formatCheck, formatList, listJson, parseArgs } from "./cli.js";
import { tree } from "./fixture.js";
import type { CheckResult, GoalResult, Report } from "./goals.js";

const ok = (name: string, count: number): CheckResult => ({
  name,
  description: `${name} holds.`,
  count,
  allowed: count,
  status: "ok",
  violations: Array.from({ length: count }, (_, i) => `v${i}`),
});
const report = (goals: GoalResult[]): Report => ({
  ok: goals.every((g) => g.problems.length === 0 && g.checks.every((c) => c.status === "ok")),
  goals,
});

const failing = report([
  {
    goal: "wake-gate-in-core",
    problems: [
      { problem: "baseline-unreadable", detail: "baseline.json is missing" },
      { problem: "stale-baseline-key", key: "old-check" },
      { problem: "duplicate-check-name", name: "twice" },
    ],
    checks: [
      ok("fine", 1),
      {
        name: "no-app-decides-a-wake",
        description: "No app decides whether a message wakes an agent.",
        count: 53,
        allowed: 2,
        status: "raised",
        violations: Array.from({ length: 53 }, (_, i) => `rome_apps/a${i}.ts: imports x`),
      },
      {
        name: "lower-me",
        description: "Lower me holds.",
        count: 1,
        allowed: 3,
        status: "can-lower",
        violations: ["a"],
      },
      {
        name: "unlisted",
        description: "Unlisted holds.",
        count: 2,
        status: "no-baseline",
        violations: ["a", "b"],
      },
      { name: "throws", description: "Throws holds.", allowed: 1, status: "error", error: "boom" },
    ],
  },
  { goal: "done", problems: [], checks: [ok("all-gone", 0)] },
  { goal: "empty", problems: [{ problem: "no-checks" }], checks: [] },
]);

describe("parseArgs", () => {
  const root = tree({ "a.txt": "" });
  it.each([
    [[], { root, json: false }],
    [["--json"], { root, json: true }],
    [["--root", "."], { root, json: false }],
    [["--root", root, "--json"], { root, json: true }],
    [["--json", `--root=${root}`], { root, json: true }],
  ])("reads %j", (argv, want) => {
    expect(parseArgs(argv, root)).toEqual(want);
  });

  it.each([
    [["--bogus"]],
    [["--root"]],
    [["--json", "--json"]],
    [["--root", ".", "--root", "."]],
    [["extra"]],
    [["--root", "missing"]],
    [["--root", "a.txt"]],
  ])("rejects %j", (argv) => {
    expect(parseArgs(argv, root)).toHaveProperty("usage");
  });

  it("resolves --root against the working folder", () => {
    expect(parseArgs(["--root", ".."], join(root, "."))).toEqual({
      root: join(root, ".."),
      json: false,
    });
  });
});

describe("formatCheck", () => {
  const out = formatCheck(failing);

  it("names the goal, the check, its description and its counts for every check that is not ok", () => {
    for (const c of failing.goals[0].checks.filter((c) => c.status !== "ok")) {
      expect(out).toContain(`wake-gate-in-core / ${c.name}`);
      expect(out).toContain(c.description);
    }
    expect(out).toContain("53 violations, 2 allowed");
    expect(out).not.toContain("wake-gate-in-core / fine");
  });

  it("says what to do for each status", () => {
    expect(out).toContain("Remove violations until the count is at most 2");
    expect(out).toContain('Lower "lower-me" in goals/wake-gate-in-core/baseline.json to 1.');
    expect(out).toContain('Add "unlisted": 2 to goals/wake-gate-in-core/baseline.json.');
    expect(out).toContain("The check could not run: boom");
  });

  it("shows 50 violations, then how many more", () => {
    expect(out).toContain("rome_apps/a49.ts: imports x");
    expect(out).not.toContain("rome_apps/a50.ts: imports x");
    expect(out).toContain("and 3 more");
  });

  it("names every goal problem", () => {
    expect(out).toContain("goals/wake-gate-in-core: baseline-unreadable: baseline.json is missing");
    expect(out).toContain('"old-check"');
    expect(out).toContain('"twice"');
    expect(out).toContain("goals/empty: no-checks");
  });

  it("ends with one summary line", () => {
    expect(out.trimEnd().split("\n").at(-1)).toBe(
      "Goals failed: 4 of 6 checks not ok, 4 goal problems.",
    );
  });

  it("prints one line per goal with its counts when everything is ok", () => {
    const passing = report([
      { goal: "a", problems: [], checks: [ok("x", 2), ok("y", 0)] },
      { goal: "b", problems: [], checks: [ok("z", 0)] },
    ]);
    expect(formatCheck(passing)).toBe(
      "a: 2 remaining (x 2, y 0)\nb: 0 remaining (z 0)\nGoals ok: 3 checks in 2 goals match their baselines.\n",
    );
    expect(formatCheck(report([]))).toBe(
      "No goals under goals/.\nGoals ok: 0 checks in 0 goals match their baselines.\n",
    );
  });
});

describe("checkJson", () => {
  it("drops the detail of a problem and keeps every violation", () => {
    const json = JSON.parse(JSON.stringify(checkJson(failing)));
    expect(json.ok).toBe(false);
    expect(json.goals[0].problems[0]).toEqual({ problem: "baseline-unreadable" });
    expect(json.goals[0].checks[1].violations).toHaveLength(53);
    expect(json.goals[0].checks[4]).toEqual({
      name: "throws",
      description: "Throws holds.",
      allowed: 1,
      status: "error",
      error: "boom",
    });
  });
});

describe("listJson", () => {
  it("sums counts and marks only a clean goal at zero ready to close", () => {
    const json = JSON.parse(JSON.stringify(listJson(failing)));
    expect(json).toEqual({
      goals: [
        {
          goal: "wake-gate-in-core",
          remaining: 57,
          readyToClose: false,
          problems: [
            { problem: "baseline-unreadable" },
            { problem: "stale-baseline-key", key: "old-check" },
            { problem: "duplicate-check-name", name: "twice" },
          ],
          checks: [
            { name: "fine", count: 1, allowed: 1, status: "ok" },
            { name: "no-app-decides-a-wake", count: 53, allowed: 2, status: "raised" },
            { name: "lower-me", count: 1, allowed: 3, status: "can-lower" },
            { name: "unlisted", count: 2, status: "no-baseline" },
            { name: "throws", allowed: 1, status: "error" },
          ],
        },
        {
          goal: "done",
          remaining: 0,
          readyToClose: true,
          problems: [],
          checks: [{ name: "all-gone", count: 0, allowed: 0, status: "ok" }],
        },
        {
          goal: "empty",
          remaining: 0,
          readyToClose: false,
          problems: [{ problem: "no-checks" }],
          checks: [],
        },
      ],
    });
  });

  it("does not mark a goal at zero ready to close while a check is not ok", () => {
    const g: GoalResult = {
      goal: "g",
      problems: [],
      checks: [
        { name: "c", description: "d", count: 0, allowed: 1, status: "can-lower", violations: [] },
      ],
    };
    expect(JSON.parse(JSON.stringify(listJson(report([g])))).goals[0].readyToClose).toBe(false);
  });
});

describe("formatList", () => {
  it("prints each goal with its total and checks, and marks the ones ready to close", () => {
    expect(formatList(failing)).toBe(
      [
        "wake-gate-in-core: 57 remaining in 5 checks",
        "  fine: 1 (allowed 1)",
        "  no-app-decides-a-wake: 53 (allowed 2, raised)",
        "  lower-me: 1 (allowed 3, can-lower)",
        "  unlisted: 2 (no baseline)",
        "  throws: error, could not run (allowed 1)",
        "  problem: baseline-unreadable: baseline.json is missing. Its checks run as no-baseline.",
        '  problem: stale-baseline-key: baseline.json has "old-check", which names no check. Remove it.',
        '  problem: duplicate-check-name: more than one check is named "twice". Rename one.',
        "done: 0 remaining in 1 check, ready to close",
        "  all-gone: 0 (allowed 0)",
        "empty: 0 remaining in 0 checks",
        "  problem: no-checks: the goal has no check in checks/*.ts.",
        "",
      ].join("\n"),
    );
  });

  it("says when there are no goals", () => {
    expect(formatList(report([]))).toBe("No open goals.\n");
  });
});
