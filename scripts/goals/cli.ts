// Argument parsing and output for check.ts and list.ts. Contract: the
// "Command: check" and "Command: list" sections of the goals contract.

import { statSync } from "node:fs";
import { resolve } from "node:path";
import type { CheckResult, GoalResult, Problem, Report } from "./goals.js";

export interface Args {
  root: string;
  json: boolean;
}

/** Parses `[--root <dir>] [--json]`. Returns a message for bad arguments, including a root that is not a folder. */
export function parseArgs(argv: string[], cwd: string): Args | { usage: string } {
  let root: string | undefined;
  let json = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--json" && !json) json = true;
    else if (a === "--root" && root === undefined && argv[i + 1] !== undefined) root = argv[++i];
    else if (a.startsWith("--root=") && root === undefined) root = a.slice("--root=".length);
    else return { usage: `unexpected argument: ${a}` };
  }
  const abs = resolve(cwd, root ?? ".");
  let isDir = false;
  try {
    isDir = statSync(abs).isDirectory();
  } catch {}
  if (!isDir) return { usage: `--root is not a folder: ${abs}` };
  return { root: abs, json };
}

/** The `check --json` object: problems without their `detail`. */
export function checkJson(report: Report): unknown {
  return {
    ok: report.ok,
    goals: report.goals.map((g) => ({ ...g, problems: g.problems.map(problemJson) })),
  };
}

/** The `list --json` object. */
export function listJson(report: Report): unknown {
  return {
    goals: report.goals.map((g) => ({
      goal: g.goal,
      remaining: remaining(g),
      readyToClose: readyToClose(g),
      problems: g.problems.map(problemJson),
      checks: g.checks.map(({ name, count, allowed, status }) => ({
        name,
        count,
        allowed,
        status,
      })),
    })),
  };
}

const MAX_SHOWN = 50;

/** The `check` plain output: a block per check that is not `ok`, per goal problem, then a summary line. */
export function formatCheck(report: Report): string {
  const lines: string[] = [];
  let checks = 0;
  let failing = 0;
  let problems = 0;
  for (const g of report.goals) {
    for (const p of g.problems) {
      problems += 1;
      lines.push(`goals/${g.goal}: ${problemText(p)}`, "");
    }
    for (const c of g.checks) {
      checks += 1;
      if (c.status === "ok") continue;
      failing += 1;
      lines.push(...checkBlock(g.goal, c), "");
    }
  }
  if (report.ok) {
    for (const g of report.goals) {
      const counts = g.checks.map((c) => `${c.name} ${c.count}`).join(", ");
      lines.push(`${g.goal}: ${remaining(g)} remaining (${counts})`);
    }
    if (report.goals.length === 0) lines.push("No goals under goals/.");
    lines.push(
      `Goals ok: ${checks} ${plural(checks, "check")} in ${report.goals.length} ${plural(report.goals.length, "goal")} match their baselines.`,
    );
  } else {
    const parts: string[] = [];
    if (failing > 0) parts.push(`${failing} of ${checks} ${plural(checks, "check")} not ok`);
    if (problems > 0) parts.push(`${problems} goal ${plural(problems, "problem")}`);
    lines.push(`Goals failed: ${parts.join(", ")}.`);
  }
  return `${lines.join("\n")}\n`;
}

/** The `list` plain output: a line per goal, then an indented line per check. */
export function formatList(report: Report): string {
  if (report.goals.length === 0) return "No open goals.\n";
  const lines: string[] = [];
  for (const g of report.goals) {
    const n = g.checks.length;
    const ready = readyToClose(g) ? ", ready to close" : "";
    lines.push(`${g.goal}: ${remaining(g)} remaining in ${n} ${plural(n, "check")}${ready}`);
    for (const c of g.checks) {
      const allowed = c.allowed === undefined ? "no baseline" : `allowed ${c.allowed}`;
      if (c.status === "error") {
        lines.push(`  ${c.name}: error, could not run (${allowed})`);
      } else {
        const status = c.status === "ok" || c.status === "no-baseline" ? "" : `, ${c.status}`;
        lines.push(`  ${c.name}: ${c.count} (${allowed}${status})`);
      }
    }
    for (const p of g.problems) lines.push(`  problem: ${problemText(p)}`);
  }
  return `${lines.join("\n")}\n`;
}

function checkBlock(goal: string, c: CheckResult): string[] {
  const where = `goals/${goal}/baseline.json`;
  const lines = [`FAIL ${goal} / ${c.name}: ${c.status}`, `  ${c.description}`];
  switch (c.status) {
    case "raised":
      lines.push(
        `  ${c.count} violations, ${c.allowed} allowed. Remove violations until the count is at most ${c.allowed}; the baseline never goes up.`,
      );
      break;
    case "can-lower":
      lines.push(
        `  ${c.count} violations, ${c.allowed} allowed. Lower "${c.name}" in ${where} to ${c.count}.`,
      );
      break;
    case "no-baseline":
      lines.push(`  ${c.count} violations, no baseline. Add "${c.name}": ${c.count} to ${where}.`);
      break;
    case "error":
      lines.push(`  The check could not run: ${c.error}`);
      break;
  }
  const shown = (c.violations ?? []).slice(0, MAX_SHOWN);
  for (const v of shown) lines.push(`    ${v}`);
  const more = (c.violations?.length ?? 0) - shown.length;
  if (more > 0) lines.push(`    and ${more} more`);
  return lines;
}

function problemText(p: Problem): string {
  switch (p.problem) {
    case "baseline-unreadable":
      return `baseline-unreadable: ${p.detail ?? "baseline.json cannot be read"}. Its checks run as no-baseline.`;
    case "stale-baseline-key":
      return `stale-baseline-key: baseline.json has "${p.key}", which names no check. Remove it.`;
    case "duplicate-check-name":
      return `duplicate-check-name: more than one check is named "${p.name}". Rename one.`;
    case "no-checks":
      return "no-checks: the goal has no check in checks/*.ts.";
  }
}

function problemJson(p: Problem): Problem {
  if (p.problem !== "baseline-unreadable") return p;
  return { problem: p.problem };
}

function remaining(g: GoalResult): number {
  return g.checks.reduce((sum, c) => sum + (c.count ?? 0), 0);
}

function readyToClose(g: GoalResult): boolean {
  return (
    g.problems.length === 0 &&
    g.checks.length > 0 &&
    g.checks.every((c) => c.status === "ok" && c.count === 0)
  );
}

function plural(n: number, word: string): string {
  return n === 1 ? word : `${word}s`;
}
