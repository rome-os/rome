// Runs the selected scenarios against the environment and writes the report.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { RULES_VERSION, SCENARIOS } from "../scenarios/index.mjs";
import { renderMarkdown } from "./report.mjs";
import { JUDGE_CALIBRATION } from "./judge.mjs";
import { ask, ruleResult } from "./scenario.mjs";
import { loadK5Questions, loadTeam, writeSeed } from "./seed.mjs";

const verifierDir = dirname(dirname(fileURLToPath(import.meta.url)));

/** The mention that opens every run. A run whose agent does not answer it scores nothing. */
export const LIVENESS_TEXT = "Good morning, are you around today?";
export const NOT_ANSWERING = "agent not answering, environment or Rome fault until shown otherwise";

export const DEFAULT_RUNS_DIR = join(homedir(), ".rome-environments/chief-of-staff/runs");

function tally(items) {
  const count = (status) => items.filter((i) => i.status === status).length;
  return {
    of: items.length,
    pass: count("pass"),
    fail: count("fail"),
    waitsOnDesign: count("waits_on_design"),
    notChecked: count("not_checked"),
  };
}

/**
 * Two kinds of number: the rules scored whole, and each rule scored by leg (K3), whose legs
 * are tallied on their own. `agentFailures` counts failures that are the agent's: a leg that
 * waits on a design decision is not one.
 */
export function summarize(allResults) {
  const results = allResults.filter((r) => r.scored !== false);
  const whole = results.filter((r) => !r.byLeg);
  const byLeg = Object.fromEntries(
    results.filter((r) => r.byLeg).map((r) => [r.rule, tally(r.checks)]),
  );
  const agentFailures =
    tally(whole).fail + Object.values(byLeg).reduce((sum, legs) => sum + legs.fail, 0);
  return { rules: tally(whole), byLeg, agentFailures };
}

/** A rule at this many failures across runs is one failure from stopping the loop. */
export const FAILURE_LIMIT = 3;

/**
 * Failures per rule across every earlier run whose report sits in `runsRoot`, plus `results`.
 * Ouou's rule stops the loop when a rule fails more than FAILURE_LIMIT times. Not checked and
 * waiting on a design decision are not failures. A run folder's regrade.json, written when the
 * planner regrades a run under new rules, replaces the statuses of the rules it lists.
 */
export function failureHistory(runsRoot, currentDir, results) {
  const counts = {};
  const runs = [];
  const add = (rule) => {
    counts[rule] = (counts[rule] ?? 0) + 1;
  };
  for (const name of existsSync(runsRoot) ? readdirSync(runsRoot).sort() : []) {
    const path = join(runsRoot, name, "report.json");
    if (join(runsRoot, name) === currentDir || !existsSync(path)) continue;
    try {
      const earlier = JSON.parse(readFileSync(path, "utf8"));
      const regradePath = join(runsRoot, name, "regrade.json");
      const regraded = existsSync(regradePath)
        ? JSON.parse(readFileSync(regradePath, "utf8")).results
        : [];
      runs.push(name);
      for (const r of earlier.results ?? []) {
        if (r.scored === false) continue;
        const status = regraded.find((g) => g.rule === r.rule)?.status ?? r.status;
        if (status === "fail") add(r.rule);
      }
    } catch {
      // An unreadable report counts no failures.
    }
  }
  for (const r of results) if (r.status === "fail" && r.scored !== false) add(r.rule);
  return { earlierRuns: runs, counts, limit: FAILURE_LIMIT };
}

const NO_ANSWER = /no answer|no reply/;

/**
 * The agent's replies the envoy held or rejected during the run, each with the rule whose
 * question it answered. A failed check whose missing answer is one of them keeps its failure
 * (the team got no answer) but is tagged as stopped by the envoy, so it never reads as the
 * agent's fault. K7 handles its own probes. Environments without `cos-env rome held` list none.
 */
async function envoyStops(env, startedAt, answerTimes, results) {
  let held;
  try {
    held = await env.held(startedAt.toISOString());
  } catch {
    return [];
  }
  const stops = (Array.isArray(held) ? held : [])
    .filter((h) => h.status !== "approved")
    .map((h) => {
      const asked = answerTimes.find((t) => t.questionId === h.question);
      return {
        rule: asked?.rule ?? null,
        chat: asked?.chat ?? null,
        kind: asked?.kind ?? null,
        questionId: h.question,
        status: h.status,
        reply: h.reply,
        reason: h.reason,
        scored: false,
      };
    });
  for (const stop of stops) {
    // A held reply to a statement leaves no question unanswered.
    if (stop.kind !== "question") continue;
    for (const result of results) {
      for (const c of result.checks ?? []) {
        if (
          c.status !== "fail" ||
          !c.evidence.includes(stop.questionId) ||
          !NO_ANSWER.test(c.detail)
        )
          continue;
        c.detail = `${c.detail} (fail: the envoy stopped the agent's reply, ${stop.status}: ${stop.reason})`;
        c.stoppedByEnvoy = true;
        result.stoppedByEnvoy = true;
        result.reason = ruleResult(result.checks).reason;
        stop.scored = true;
      }
    }
  }
  return stops;
}

/** The scenarios for `rules` when given, else every rule of `phase` and the phases before it. */
export function selectScenarios({ rules, phase }) {
  if (rules) {
    const wanted = new Set(rules);
    return {
      scenarios: SCENARIOS.filter((s) => wanted.has(s.rule)),
      missing: rules.filter((r) => !SCENARIOS.some((s) => s.rule === r)),
    };
  }
  const at = phase ?? 1;
  return {
    scenarios: SCENARIOS.filter((s) => s.phase <= at),
    missing: [],
    moved: SCENARIOS.filter((s) => s.movedFrom !== undefined && s.movedFrom <= at && s.phase > at),
  };
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

// The chief of staff app's commit names the run: the installed app when the environment
// reports one, else the Rome build that carried the app.
function agentCommit(version) {
  return String(version.app?.commit ?? version.agent?.commit ?? "unknown").slice(0, 12);
}

function writeReport(dir, report) {
  writeFileSync(join(dir, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  writeFileSync(join(dir, "report.md"), renderMarkdown(report));
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
  notes = [],
  rules,
  phase,
  waits,
  allowDirty,
  runsDir,
  outDir,
  log,
  expectAppRef,
}) {
  const startedAt = new Date();
  const version = { ...(await env.version()), verifier: verifierCommit() };
  const dirty = dirtyParts(version);
  if (dirty.length > 0 && !allowDirty) {
    throw new Error(`uncommitted changes in ${dirty.join(", ")}; commit them or pass --dirty`);
  }
  const { scenarios, missing, moved = [] } = selectScenarios({ rules, phase });
  const stamp = startedAt.toISOString().replace(/[:.]/g, "-");
  const dir = outDir ?? join(runsDir ?? DEFAULT_RUNS_DIR, `${stamp}-${agentCommit(version)}`);
  mkdirSync(dir, { recursive: true });

  const team = loadTeam();
  await env.reset();
  await env.seed(writeSeed(team, join(dir, "seed")));
  // A reset can reinstall Rome or the app from the environment's settings, so the build under
  // test is read again after it, and checked against the one the run was asked for.
  Object.assign(version, await env.version(), { verifier: version.verifier });
  if (expectAppRef && version.app?.ref !== expectAppRef) {
    throw new Error(
      `the environment runs app ref ${version.app?.ref ?? "unknown"} at ${version.app?.commit ?? "unknown"}, not ${expectAppRef}; bring it up on the build under test`,
    );
  }
  for (const member of team.members)
    await env.rename({ as: member.account, displayName: member.name });

  const answered = { sent: 0, answered: 0 };
  const answerTimes = [];
  const romeEvents = [];
  const ctx = {
    env,
    judge,
    team,
    k5Questions: loadK5Questions(),
    waits,
    phase: phase ?? 1,
    // The environment's model setting, for turns whose own model the environment does not record.
    model: version.model?.name ?? null,
    memo: {},
    log,
    answered,
    answerTimes,
    romeEvents,
  };
  // The parts of the report known before the rules run, kept current as they run.
  let liveness;
  let live;
  const head = () => ({
    rulesVersion: RULES_VERSION,
    startedAt: startedAt.toISOString(),
    finishedAt: new Date().toISOString(),
    underTest: version,
    dirty,
    judge: judgeName,
    judgeCalibration: JUDGE_CALIBRATION,
    runFrom: { dir: dirname(dirname(dirname(verifierDir))), commit: version.verifier.commit },
    waits,
    notes: [
      "Direct messages use a private chat (dm-<member>) only the agent and that member can read, since a bot cannot send a bot a direct message. Rome sees that chat as a group chat, so a question there mentions the agent to ping it, as a real direct message would. The real direct-message path is checked by hand in the live trial.",
      ...notes,
    ],
    selection: rules ? { rules } : { phase: phase ?? 1 },
    liveness: { questionId: liveness.questionId, replyId: liveness.reply?.id ?? null },
    stopped: live ? null : NOT_ANSWERING,
    answered,
    answerTimes,
    romeEvents,
  });
  liveness = await ask(ctx, {
    as: team.members[0].account,
    chat: "general",
    text: LIVENESS_TEXT,
  });
  live = Boolean(liveness.reply);
  const results = [];
  for (const scenario of live ? scenarios : []) {
    log(`running ${scenario.rule} ${scenario.title}`);
    ctx.rule = scenario.rule;
    const ruleStarted = Date.now();
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
    if (
      result.status === "fail" &&
      romeEvents.some((e) => e.rule === scenario.rule && e.outcome === "Rome was down")
    ) {
      result = {
        ...result,
        status: "not_checked",
        reason: `Rome was down: ${result.reason}`,
      };
    }
    const unscored = scenario.unscoredFrom && (phase ?? 1) >= scenario.unscoredFrom;
    results.push({
      rule: scenario.rule,
      title: scenario.title,
      phase: scenario.phase,
      byLeg: Boolean(scenario.legs),
      ...result,
      ...(unscored ? { scored: false, unscoredWhy: scenario.unscoredWhy } : {}),
      seconds: Math.round((Date.now() - ruleStarted) / 1000),
    });
    log(`${scenario.rule}: ${result.status}`);
    // Each rule's result is readable as soon as it lands; the finished report replaces this.
    writeReport(dir, {
      ...head(),
      inProgress: true,
      stoppedByEnvoy: [],
      logs: "copied when the run finishes",
      summary: summarize(results),
      failures: { earlierRuns: [], counts: {}, limit: FAILURE_LIMIT },
      results,
    });
  }
  for (const rule of live ? missing : []) {
    results.push({
      rule,
      status: "not_checked",
      reason: "no scenario for this rule yet",
      evidence: [],
      checks: [],
    });
  }

  for (const scenario of live ? moved : []) {
    results.push({
      rule: scenario.rule,
      title: scenario.title,
      status: "not_checked",
      scored: false,
      reason: "moved to a later phase, not run (Ouou, 2026-11-17)",
      evidence: [],
      checks: [],
    });
  }

  const stoppedByEnvoy = await envoyStops(env, startedAt, answerTimes, results);

  // Rome's logs sit beside the report so a silent or failing run can be traced. A copy that
  // fails is noted in the report, not fatal: the scores stand without it.
  let logs = "logs";
  try {
    await env.logs(join(dir, "logs"), startedAt.toISOString());
  } catch (error) {
    logs = `not copied: ${error.message}`;
  }

  // An observation only: the rules take their evidence from the chat.
  let memory;
  try {
    memory = await env.memory(startedAt.toISOString());
  } catch (error) {
    memory = { notObserved: error.message };
  }

  const report = {
    ...head(),
    memory,
    stoppedByEnvoy,
    logs,
    summary: summarize(results),
    failures: failureHistory(runsDir ?? (outDir ? dirname(dir) : DEFAULT_RUNS_DIR), dir, results),
    results,
  };
  writeReport(dir, report);
  return { report, outDir: dir };
}
