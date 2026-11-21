// Runs check.ts and list.ts as the workflow does, through tsx, on temporary
// trees that carry their own copy of scripts/goals/ and the gate's glob.ts.

import { describe, expect, it } from "@rstest/core";
import { spawnSync } from "node:child_process";
import { cpSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { tree } from "./fixture.js";

const here = resolve(__dirname);
const tsx = resolve(here, "../../node_modules/.bin/tsx");

function repo(files: Record<string, string>): string {
  const root = tree(files);
  for (const name of readdirSync(here).filter(
    (n) => n.endsWith(".ts") && !n.endsWith(".test.ts"),
  )) {
    cpSync(join(here, name), join(root, "scripts/goals", name));
  }
  cpSync(join(here, "../merge-gate/glob.ts"), join(root, "scripts/merge-gate/glob.ts"));
  return root;
}

// Runs the copy of `script` inside `cwd`, or the one in this folder with `here`.
function run(script: string, args: string[], cwd: string, from = join(cwd, "scripts/goals")) {
  const r = spawnSync(tsx, [join(from, script), ...args], { cwd, encoding: "utf8" });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}

const forbid = `import { forbidImports } from "../../../scripts/goals/imports.js";
console.log("loading the check");
export default forbidImports({
  name: "no-app-imports-core",
  description: "No app imports core.",
  from: ["app/**"],
  to: ["core/**"],
  aliases: { "@/": "" },
});
`;
const typed = `import type { Check } from "../../../scripts/goals/types.js";
const checks: Check[] = [
  { name: "zero", description: "Zero holds.", violations: () => { console.log("running"); return []; } },
];
export default checks;
`;

describe("check.ts and list.ts", () => {
  const root = repo({
    "goals/imports/rules.md": "Apps reach core through its API.",
    "goals/imports/baseline.json": '{"no-app-imports-core": 1}',
    "goals/imports/checks/forbid.ts": forbid,
    "goals/done/baseline.json": '{"zero": 0}',
    "goals/done/checks/zero.ts": typed,
    "app/a.ts": 'import "../core/a.js";\nimport "@/core/b";',
  });

  it("fails a raised count and names the goal, check and description", () => {
    const r = run("check.ts", [], root);
    expect(r.code).toBe(1);
    expect(r.stdout).toContain("FAIL imports / no-app-imports-core: raised");
    expect(r.stdout).toContain("No app imports core.");
    expect(r.stdout).toContain("app/a.ts: imports core/b");
    expect(r.stdout).not.toContain("loading the check");
    expect(r.stderr).toContain("loading the check");
  });

  it("prints exactly one JSON object on stdout even when checks log", () => {
    const r = run("check.ts", ["--json"], root);
    expect(r.code).toBe(1);
    const json = JSON.parse(r.stdout);
    expect(json.goals.map((g: { goal: string }) => g.goal)).toEqual(["done", "imports"]);
    expect(json.goals[1].checks[0]).toEqual({
      name: "no-app-imports-core",
      description: "No app imports core.",
      count: 2,
      allowed: 1,
      status: "raised",
      violations: ["app/a.ts: imports core/a.js", "app/a.ts: imports core/b"],
    });
  });

  it("runs this folder's command on another root", () => {
    const r = run("check.ts", ["--root", root, "--json"], here, here);
    expect(JSON.parse(r.stdout).goals).toHaveLength(2);
  });

  it("lists every goal and marks the ready one, exiting 0", () => {
    const r = run("list.ts", [], root);
    expect(r.code).toBe(0);
    expect(r.stdout).toBe(
      [
        "done: 0 remaining in 1 check, ready to close",
        "  zero: 0 (allowed 0)",
        "imports: 2 remaining in 1 check",
        "  no-app-imports-core: 2 (allowed 1, raised)",
        "",
      ].join("\n"),
    );
    expect(JSON.parse(run("list.ts", ["--json"], root).stdout).goals[0]).toEqual({
      goal: "done",
      remaining: 0,
      readyToClose: true,
      problems: [],
      checks: [{ name: "zero", count: 0, allowed: 0, status: "ok" }],
    });
  });

  it("passes in a tree with no goals", () => {
    const empty = repo({ "README.md": "x" });
    expect(run("check.ts", [], empty).code).toBe(0);
    expect(run("list.ts", [], empty).stdout).toBe("No open goals.\n");
  });

  it("passes when every count equals its baseline", () => {
    const r = repo({
      "goals/g/baseline.json": '{"zero": 0}',
      "goals/g/checks/zero.ts": typed,
      "package.json": '{"type": "module"}',
    });
    const out = run("check.ts", [], r);
    expect(out.code).toBe(0);
    expect(out.stdout).toBe(
      "g: 0 remaining (zero 0)\nGoals ok: 1 check in 1 goal match their baselines.\n",
    );
  });

  it("reports a check file that does not compile as an error", () => {
    const r = repo({
      "goals/g/baseline.json": "{}",
      "goals/g/checks/bad.ts": "export default {{;",
    });
    const json = JSON.parse(run("check.ts", ["--json"], r).stdout);
    expect(json.goals[0].checks[0]).toMatchObject({ name: "checks/bad.ts", status: "error" });
  });

  it.each([["check.ts"], ["list.ts"]])("exits 2 for bad arguments to %s", (script) => {
    expect(run(script, ["--nope"], root).code).toBe(2);
    expect(run(script, ["--root"], root).code).toBe(2);
    expect(run(script, ["--root", join(root, "missing")], root).code).toBe(2);
  });
});
