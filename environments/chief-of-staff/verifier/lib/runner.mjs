// Runs the selected scenarios against the environment and writes the report.
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { RULES_VERSION, SCENARIOS } from "../scenarios/index.mjs";
import { renderMarkdown } from "./report.mjs";
import { loadK5Questions, loadTeam, writeSeed } from "./seed.mjs";

const verifierDir = dirname(dirname(fileURLToPath(import.meta.url)));

export const DEFAULT_RUNS_DIR = join(homedir(), ".rome-environments/chief-of-staff/runs");

/** The scenarios for `rules` when given, else every rule of `phase` and the phases before it. */
export function selectScenarios({ rules, phase }) {
  if (rules) {
    const wanted = new Set(rules);
    return {
      scenarios: SCENARIOS.filter((s) => wanted.has(s.rule)),
      missing: rules.filter((r) => !SCENARIOS.some((s) => s.rule === r)),
    };
  }
  return { scenarios: SCENARIOS.filter((s) => s.phase <= (phase ?? 1)), missing: [] };
}

function verifierCommit() {
  try {
    const commit = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: verifierDir,
      encoding: "utf8",
    }).trim();
    const status = execFileSync("git", ["status", "--porcelain", "--", "."], {
      cwd: verifierDir,
      encoding: "utf8",
    });
    return { commit, dirty: status.trim().length > 0 };
  } catch {
    return { commit: "unknown", dirty: true };
  }
}

/** The parts of `version` (and the verifier itself) that have uncommitted changes. */
export function dirtyParts(version) {
  return Object.entries(version)
    .filter(([, part]) => part && typeof part === "object" && part.dirty === true)
    .map(([name]) => name);
}

function agentCommit(version) {
  return String(version.agent?.commit ?? "unknown").slice(0, 12);
}

/**
 * Runs the scenarios and writes report.json and report.md. Throws before touching the
 * environment when anything under test has uncommitted changes and `allowDirty` is false.
 * Resolves to `{ report, outDir }`.
 */
export async function verify({
  env,
  judge,
  judgeName,
  rules,
  phase,
  waits,
  allowDirty,
  runsDir,
  outDir,
  log,
}) {
  const startedAt = new Date();
  const version = { ...(await env.version()), verifier: verifierCommit() };
  const dirty = dirtyParts(version);
  if (dirty.length > 0 && !allowDirty) {
    throw new Error(`uncommitted changes in ${dirty.join(", ")}; commit them or pass --dirty`);
  }
  const { scenarios, missing } = selectScenarios({ rules, phase });
  const stamp = startedAt.toISOString().replace(/[:.]/g, "-");
  const dir = outDir ?? join(runsDir ?? DEFAULT_RUNS_DIR, `${stamp}-${agentCommit(version)}`);
  mkdirSync(dir, { recursive: true });

  const team = loadTeam();
  await env.reset();
  await env.seed(writeSeed(team, join(dir, "seed")));
  for (const member of team.members)
    await env.rename({ as: member.account, displayName: member.name });

  const ctx = { env, judge, team, k5Questions: loadK5Questions(), waits, memo: {}, log };
  const results = [];
  for (const scenario of scenarios) {
    log(`running ${scenario.rule} ${scenario.title}`);
    let result;
    try {
      result = await scenario.run(ctx);
    } catch (error) {
      result = {
        status: "not_checked",
        reason: `scenario stopped: ${error.message}`,
        evidence: [],
        checks: [],
      };
    }
    results.push({ rule: scenario.rule, title: scenario.title, phase: scenario.phase, ...result });
    log(`${scenario.rule}: ${result.status}`);
  }
  for (const rule of missing) {
    results.push({
      rule,
      status: "not_checked",
      reason: "no scenario for this rule yet",
      evidence: [],
      checks: [],
    });
  }

  const report = {
    rulesVersion: RULES_VERSION,
    startedAt: startedAt.toISOString(),
    finishedAt: new Date().toISOString(),
    underTest: version,
    dirty,
    judge: judgeName,
    waits,
    selection: rules ? { rules } : { phase: phase ?? 1 },
    summary: {
      pass: results.filter((r) => r.status === "pass").length,
      fail: results.filter((r) => r.status === "fail").length,
      notChecked: results.filter((r) => r.status === "not_checked").length,
    },
    results,
  };
  writeFileSync(join(dir, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  writeFileSync(join(dir, "report.md"), renderMarkdown(report));
  return { report, outDir: dir };
}
