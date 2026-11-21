// Runs every goal's checks and compares each count with its baseline. Shared
// by check.ts and list.ts. Contract: the goals contract, sections "Layout" to
// "Command: list". A goal is a folder `goals/<goal>/` under the root.

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { Check } from "./types.js";

export type Status = "ok" | "raised" | "can-lower" | "no-baseline" | "error";

/**
 * One check's outcome. `allowed` is absent when the baseline has no readable
 * entry for the check. `count` and `violations` are absent when the status is
 * `error`, which carries `error` instead.
 */
export interface CheckResult {
  name: string;
  description: string;
  count?: number;
  allowed?: number;
  status: Status;
  violations?: string[];
  error?: string;
}

/** A problem with a goal as a whole. `detail` explains it to people and is left out of JSON. */
export type Problem =
  | { problem: "baseline-unreadable"; detail?: string }
  | { problem: "stale-baseline-key"; key: string }
  | { problem: "duplicate-check-name"; name: string }
  | { problem: "no-checks" };

export interface GoalResult {
  goal: string;
  problems: Problem[];
  checks: CheckResult[];
}

export interface Report {
  /** True when every check is `ok` and no goal has a problem. */
  ok: boolean;
  goals: GoalResult[];
}

/** Loads a module by absolute path and resolves to its namespace. */
export type LoadModule = (file: string) => Promise<unknown>;

const importModule: LoadModule = (file) => import(pathToFileURL(file).href);

/** Runs every goal under `<root>/goals/`, in name order. A missing `goals/` yields no goals. */
export async function runGoals(root: string, load: LoadModule = importModule): Promise<Report> {
  const dir = join(root, "goals");
  const names = existsSync(dir)
    ? readdirSync(dir, { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => e.name)
        .sort()
    : [];
  const goals: GoalResult[] = [];
  for (const name of names) goals.push(await runGoal(root, name, load));
  const ok = goals.every(
    (g) => g.problems.length === 0 && g.checks.every((c) => c.status === "ok"),
  );
  return { ok, goals };
}

type Loaded = { check: Check } | { file: string; error: string };

async function runGoal(root: string, goal: string, load: LoadModule): Promise<GoalResult> {
  const goalDir = join(root, "goals", goal);
  const problems: Problem[] = [];
  const baseline = readBaseline(join(goalDir, "baseline.json"));
  if ("detail" in baseline)
    problems.push({ problem: "baseline-unreadable", detail: baseline.detail });
  const allowedFor = "detail" in baseline ? {} : baseline.counts;

  const checks: CheckResult[] = [];
  for (const loaded of await loadChecks(goalDir, load)) {
    if ("error" in loaded) {
      checks.push({
        name: loaded.file,
        description: `The check file ${loaded.file} loads and exports a Check or an array of Checks.`,
        status: "error",
        error: loaded.error,
      });
      continue;
    }
    const { check } = loaded;
    const allowed = Object.hasOwn(allowedFor, check.name) ? allowedFor[check.name] : undefined;
    const base = { name: check.name, description: check.description };
    let violations: string[];
    try {
      const got: unknown = await check.violations({ root });
      if (!Array.isArray(got) || !got.every((v) => typeof v === "string")) {
        throw new Error("violations() did not return an array of strings");
      }
      violations = got;
    } catch (err) {
      checks.push({
        ...base,
        ...(allowed === undefined ? {} : { allowed }),
        status: "error",
        error: message(err),
      });
      continue;
    }
    const count = violations.length;
    if (allowed === undefined) {
      checks.push({ ...base, count, status: "no-baseline", violations });
    } else {
      const status: Status = count > allowed ? "raised" : count < allowed ? "can-lower" : "ok";
      checks.push({ ...base, count, allowed, status, violations });
    }
  }

  const names = new Set(checks.map((c) => c.name));
  for (const key of Object.keys(allowedFor).sort()) {
    if (!names.has(key)) problems.push({ problem: "stale-baseline-key", key });
  }
  const seen = new Set<string>();
  const duplicated = new Set<string>();
  for (const c of checks) {
    if (seen.has(c.name)) duplicated.add(c.name);
    seen.add(c.name);
  }
  for (const name of [...duplicated].sort())
    problems.push({ problem: "duplicate-check-name", name });
  if (checks.length === 0) problems.push({ problem: "no-checks" });

  return { goal, problems, checks };
}

function readBaseline(file: string): { counts: Record<string, number> } | { detail: string } {
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch {
    return { detail: "baseline.json is missing" };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return { detail: `baseline.json is not valid JSON: ${message(err)}` };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { detail: "baseline.json is not a JSON object" };
  }
  const counts: Record<string, number> = Object.create(null);
  for (const [key, value] of Object.entries(parsed)) {
    if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
      return {
        detail: `baseline.json has "${key}": ${JSON.stringify(value)}, not a non-negative integer`,
      };
    }
    counts[key] = value;
  }
  return { counts };
}

// Check files are the `.ts` files directly in `checks/`, in file-name order.
// A file that fails to load becomes one entry named by its path in the goal.
async function loadChecks(goalDir: string, load: LoadModule): Promise<Loaded[]> {
  const dir = join(goalDir, "checks");
  if (!existsSync(dir) || !statSync(dir).isDirectory()) return [];
  const files = readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith(".ts"))
    .map((e) => e.name)
    .sort();
  const out: Loaded[] = [];
  for (const name of files) {
    const file = `checks/${name}`;
    try {
      const exported = defaultExport(await load(join(dir, name)));
      const list = Array.isArray(exported) ? exported : [exported];
      if (!list.every(isCheck)) {
        throw new Error("the default export is not a Check or an array of Checks");
      }
      for (const check of list) out.push({ check });
    } catch (err) {
      out.push({ file, error: message(err) });
    }
  }
  return out;
}

// tsx loads a `.ts` file outside an ESM package as CommonJS, and importing it
// then wraps its exports once more, so the Check sits at `default.default`.
function defaultExport(mod: unknown): unknown {
  const first = (mod as { default?: unknown } | null)?.default;
  if (first !== undefined && !Array.isArray(first) && !isCheck(first)) {
    const inner = (first as { default?: unknown } | null)?.default;
    if (inner !== undefined) return inner;
  }
  return first;
}

function isCheck(value: unknown): value is Check {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.name === "string" &&
    typeof v.description === "string" &&
    typeof v.violations === "function"
  );
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
