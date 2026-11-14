// Runs the selected scenarios against the environment and writes the report.
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PLACES, RULES_VERSION, RULE_PHASES, SCENARIOS } from "../scenarios/index.mjs";
import { renderMarkdown } from "./report.mjs";
import { notChecked } from "./scenario.mjs";

const verifierDir = dirname(dirname(fileURLToPath(import.meta.url)));

export const DEFAULT_RUNS_DIR = join(homedir(), ".rome-environments/voice-input/runs");

/** The rules to score: `rules` when given, else every rule of `phase` and the phases before it. */
export function selectRules({ rules, phase }) {
  if (rules) return rules;
  return Object.entries(RULE_PHASES)
    .filter(([, p]) => p <= (phase ?? 1))
    .map(([rule]) => rule);
}

function verifierCommit() {
  try {
    const git = (...args) =>
      execFileSync("git", args, { cwd: verifierDir, encoding: "utf8" }).trim();
    return {
      commit: git("rev-parse", "HEAD"),
      dirty: git("status", "--porcelain", "--", ".") !== "",
    };
  } catch {
    return { commit: "unknown", dirty: true };
  }
}

/** The parts under test that have uncommitted changes. */
export function dirtyParts(version) {
  return Object.entries(version)
    .filter(([, part]) => part && typeof part === "object" && part.dirty === true)
    .map(([name]) => name);
}

export function summarize(results) {
  const count = (status) => results.filter((r) => r.status === status).length;
  return {
    of: results.length,
    pass: count("pass"),
    fail: count("fail"),
    notChecked: count("not_checked"),
  };
}

/**
 * Runs the scenarios and writes report.json and report.md. Throws before touching the product
 * when anything under test has uncommitted changes and `allowDirty` is false. Resolves to
 * `{ report, outDir }`.
 */
export async function verify({
  env,
  script,
  rules,
  phase,
  place = "chrome",
  transcriber = "real",
  waits,
  allowDirty,
  runsDir,
  outDir,
  log,
}) {
  const startedAt = new Date();
  const version = { ...(await env.version()), verifier: verifierCommit() };
  const dirty = dirtyParts(version);
  if (dirty.length > 0 && !allowDirty)
    throw new Error(`uncommitted changes in ${dirty.join(", ")}; commit them or pass --dirty`);
  const productCommit = String(version.product?.commit ?? "unknown").slice(0, 12);
  const stamp = startedAt.toISOString().replace(/[:.]/g, "-");
  const dir = outDir ?? join(runsDir ?? DEFAULT_RUNS_DIR, `${stamp}-${productCommit}`);
  mkdirSync(dir, { recursive: true });

  const wanted = selectRules({ rules, phase });
  const ctx = { env, script, transcriber, waits, memo: {}, log };
  if (PLACES.includes(place)) await env.reset();
  const results = [];
  try {
    // A scenario's `prepare` sees the fresh instance, before any scenario has spoken into it.
    if (PLACES.includes(place)) {
      for (const scenario of SCENARIOS.filter((s) => wanted.includes(s.rule) && s.prepare)) {
        await scenario.prepare(ctx).catch((error) => {
          ctx.memo[`prepare${scenario.rule}`] = { error: error.message };
        });
      }
    }
    for (const rule of wanted) results.push(await scoreRule(rule, place, ctx));
  } finally {
    await env.stopBrowser().catch(() => {});
  }

  const report = {
    rulesVersion: RULES_VERSION,
    place,
    startedAt: startedAt.toISOString(),
    finishedAt: new Date().toISOString(),
    underTest: version,
    transcriberMode: transcriber,
    transcriberInUse: ctx.memo.transcriberInUse ?? null,
    dirty,
    waits,
    selection: rules ? { rules } : { phase: phase ?? 1 },
    summary: summarize(results),
    results,
  };
  writeFileSync(join(dir, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  writeFileSync(join(dir, "report.md"), renderMarkdown(report));
  return { report, outDir: dir };
}

async function scoreRule(rule, place, ctx) {
  const scenario = SCENARIOS.find((s) => s.rule === rule);
  let result;
  if (!PLACES.includes(place)) result = notChecked(`the verifier cannot score ${place} yet`);
  else if (!scenario) result = notChecked("no scenario for this rule yet");
  else {
    ctx.log(`running rule ${rule}: ${scenario.title}`);
    try {
      result = await scenario.run(ctx);
    } catch (error) {
      result = notChecked(`scenario stopped: ${error.message}`);
    }
  }
  ctx.log(`rule ${rule}: ${result.status}`);
  return { rule, title: scenario?.title ?? "", phase: RULE_PHASES[rule], ...result };
}
