import { describe, expect, it } from "@rstest/core";
import { join, sep } from "node:path";
import { tree } from "./fixture.js";
import { type LoadModule, runGoals } from "./goals.js";
import type { Check } from "./types.js";

const check = (name: string, violations: unknown = [], description = `${name} holds.`): Check => ({
  name,
  description,
  violations: () => violations as string[],
});
const lines = (n: number) => Array.from({ length: n }, (_, i) => `f${i}.ts: wrong`);

// Builds a tree whose check files are stubs and a loader that returns, for each
// `<goal>/checks/<file>`, the module given here, or throws a given Error.
function setup(goals: Record<string, { baseline?: string; checks?: Record<string, unknown> }>) {
  const files: Record<string, string> = {};
  const modules = new Map<string, unknown>();
  for (const [goal, g] of Object.entries(goals)) {
    if (g.baseline !== undefined) files[`goals/${goal}/baseline.json`] = g.baseline;
    files[`goals/${goal}/rules.md`] = "Free text.";
    for (const [file, mod] of Object.entries(g.checks ?? {})) {
      files[`goals/${goal}/checks/${file}`] = "// stub";
      modules.set(`${goal}/checks/${file}`, mod);
    }
  }
  const root = tree(files);
  const loaded: string[] = [];
  const load: LoadModule = async (file) => {
    const key = file
      .slice(join(root, "goals").length + 1)
      .split(sep)
      .join("/");
    loaded.push(key);
    const mod = modules.get(key);
    if (mod instanceof Error) throw mod;
    return mod;
  };
  return { root, load, loaded };
}

describe("runGoals", () => {
  it("passes with no goals folder, and with an empty one", async () => {
    expect(await runGoals(tree({ "README.md": "x" }), async () => ({}))).toEqual({
      ok: true,
      goals: [],
    });
    expect(await runGoals(tree({ "goals/notes.md": "x" }), async () => ({}))).toEqual({
      ok: true,
      goals: [],
    });
  });

  it("gives each check its status against the baseline", async () => {
    const { root, load } = setup({
      g: {
        baseline: JSON.stringify({ same: 2, up: 1, down: 3, broken: 4 }),
        checks: {
          "a.ts": {
            default: [check("same", lines(2)), check("up", lines(2)), check("down", lines(1))],
          },
          "b.ts": { default: check("new", lines(1)) },
          "c.ts": {
            default: {
              name: "broken",
              description: "Broken holds.",
              violations: () => {
                throw new Error("cannot read");
              },
            },
          },
        },
      },
    });
    const report = await runGoals(root, load);
    expect(report.ok).toBe(false);
    expect(report.goals[0].checks).toEqual([
      {
        name: "same",
        description: "same holds.",
        count: 2,
        allowed: 2,
        status: "ok",
        violations: lines(2),
      },
      {
        name: "up",
        description: "up holds.",
        count: 2,
        allowed: 1,
        status: "raised",
        violations: lines(2),
      },
      {
        name: "down",
        description: "down holds.",
        count: 1,
        allowed: 3,
        status: "can-lower",
        violations: lines(1),
      },
      {
        name: "new",
        description: "new holds.",
        count: 1,
        status: "no-baseline",
        violations: lines(1),
      },
      {
        name: "broken",
        description: "Broken holds.",
        allowed: 4,
        status: "error",
        error: "cannot read",
      },
    ]);
    expect(report.goals[0].problems).toEqual([]);
  });

  it("awaits async checks and passes the root", async () => {
    let seen = "";
    const { root, load } = setup({
      g: {
        baseline: '{"async": 1}',
        checks: {
          "a.ts": {
            default: {
              name: "async",
              description: "d",
              violations: async (ctx: { root: string }) => {
                seen = ctx.root;
                return ["x"];
              },
            },
          },
        },
      },
    });
    expect((await runGoals(root, load)).ok).toBe(true);
    expect(seen).toBe(root);
  });

  it.each([
    ["a number", 3],
    ["a string array with a number", ["a", 1]],
    ["null", null],
  ])("is an error when violations returns %s", async (_, value) => {
    const { root, load } = setup({
      g: { baseline: '{"c": 0}', checks: { "a.ts": { default: check("c", value) } } },
    });
    const c = (await runGoals(root, load)).goals[0].checks[0];
    expect(c.status).toBe("error");
    expect(c).not.toHaveProperty("count");
    expect(c).not.toHaveProperty("violations");
    expect(c.allowed).toBe(0);
  });

  it.each([
    ["throws", new Error("SyntaxError: nope"), "SyntaxError: nope"],
    [
      "exports no Check",
      { default: { name: "x" } },
      "the default export is not a Check or an array of Checks",
    ],
    [
      "has no default export",
      { other: 1 },
      "the default export is not a Check or an array of Checks",
    ],
    [
      "mixes a Check with something else",
      { default: [check("a"), 5] },
      "the default export is not a Check or an array of Checks",
    ],
  ])("reports a check file that %s as one error named by the file", async (_, mod, error) => {
    const { root, load } = setup({ g: { baseline: "{}", checks: { "bad.ts": mod } } });
    const report = await runGoals(root, load);
    expect(report.ok).toBe(false);
    expect(report.goals[0].checks).toEqual([
      expect.objectContaining({ name: "checks/bad.ts", status: "error", error }),
    ]);
    expect(report.goals[0].problems).toEqual([]);
  });

  it("unwraps a default export that tsx wrapped once more", async () => {
    const { root, load } = setup({
      g: { baseline: '{"c": 0}', checks: { "a.ts": { default: { default: check("c") } } } },
    });
    expect((await runGoals(root, load)).ok).toBe(true);
  });

  it.each([
    ["missing", undefined],
    ["not JSON", "{"],
    ["an array", "[1]"],
    ["null", "null"],
    ["a negative count", '{"c": -1}'],
    ["a fraction", '{"c": 1.5}'],
    ["a string count", '{"c": "1"}'],
    ["a nested object", '{"c": {"n": 1}}'],
  ])("reports a baseline that is %s and runs its checks as no-baseline", async (_, baseline) => {
    const { root, load } = setup({
      g: { baseline, checks: { "a.ts": { default: check("c", ["x"]) } } },
    });
    const g = (await runGoals(root, load)).goals[0];
    expect(g.problems.map((p) => p.problem)).toEqual(["baseline-unreadable"]);
    expect(g.checks).toEqual([
      { name: "c", description: "c holds.", count: 1, status: "no-baseline", violations: ["x"] },
    ]);
  });

  it("reports each stale key and each duplicated name once", async () => {
    const { root, load } = setup({
      g: {
        baseline: JSON.stringify({ zeta: 0, a: 0, gone: 1, dup: 0 }),
        checks: {
          "1.ts": { default: [check("a"), check("dup")] },
          "2.ts": { default: [check("dup"), check("dup")] },
        },
      },
    });
    const g = (await runGoals(root, load)).goals[0];
    expect(g.problems).toEqual([
      { problem: "stale-baseline-key", key: "gone" },
      { problem: "stale-baseline-key", key: "zeta" },
      { problem: "duplicate-check-name", name: "dup" },
    ]);
    expect(g.checks.map((c) => c.status)).toEqual(["ok", "ok", "ok", "ok"]);
  });

  it("reports a goal with no checks, and its keys as stale", async () => {
    const { root, load } = setup({
      empty: { baseline: '{"old": 0}' },
      none: { baseline: "{}", checks: { "a.ts": { default: [] } } },
    });
    const report = await runGoals(root, load);
    expect(report.ok).toBe(false);
    expect(report.goals.map((g) => [g.goal, g.problems])).toEqual([
      ["empty", [{ problem: "stale-baseline-key", key: "old" }, { problem: "no-checks" }]],
      ["none", [{ problem: "no-checks" }]],
    ]);
  });

  it("runs goals in name order and check files in file-name order, ignoring other files", async () => {
    const { root, load, loaded } = setup({
      b: { baseline: '{"b": 0}', checks: { "z.ts": { default: check("b") }, "notes.md": {} } },
      a: {
        baseline: '{"a2": 0, "a1": 0}',
        checks: { "2.ts": { default: check("a2") }, "1.ts": { default: check("a1") } },
      },
    });
    const report = await runGoals(root, load);
    expect(report.ok).toBe(true);
    expect(report.goals.map((g) => [g.goal, g.checks.map((c) => c.name)])).toEqual([
      ["a", ["a1", "a2"]],
      ["b", ["b"]],
    ]);
    expect(loaded).toEqual(["a/checks/1.ts", "a/checks/2.ts", "b/checks/z.ts"]);
  });
});
