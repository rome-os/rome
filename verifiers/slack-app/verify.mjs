// Scores the official Slack app against rule set v3, phases 1 to 3, in one
// environment. Usage: node verify.mjs <env.json> <out dir> <verifier commit>.
// run.sh is the entry point: it refuses uncommitted verifier code first.

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { lastRequests, resetTrail, setReachSeconds, Unreachable } from "./lib/http.mjs";
import { loadEnv } from "./lib/env.mjs";
import { hostMemory, shortOnMemory, warnedDuring } from "./lib/memory.mjs";
import { instance } from "./lib/instance.mjs";
import { fakeSlack } from "./lib/slack.mjs";
import { r4, r6, r7 } from "./rules/chat.mjs";
import { connectAs, r1, r2, r3 } from "./rules/connect.mjs";
import { r5, r8, r12, r13 } from "./rules/phase2.mjs";
import { r14 } from "./rules/groups.mjs";
import { r9, r10 } from "./rules/phase3.mjs";
import { r11 } from "./rules/structure.mjs";

const RULES = [
  { id: "R1", phase: 1, title: "One sign-in, nothing pasted", check: r1 },
  { id: "R2", phase: 3, title: "Any workspace can add it", check: r2 },
  { id: "R3", phase: 1, title: "One workspace binds to one instance", check: r3 },
  { id: "R4", phase: 1, title: "Direct messages work", check: r4 },
  { id: "R5", phase: 2, title: "Mentions in a group work", check: r5 },
  { id: "R6", phase: 1, title: "Nothing is lost while the instance is offline", check: r6 },
  { id: "R7", phase: 1, title: "Nothing forged or misrouted arrives", check: r7 },
  {
    id: "R8",
    phase: 2,
    title: "Removal marks broken; fix returns the same connected account",
    check: r8,
  },
  {
    id: "R9",
    phase: 3,
    title: "Every connector Slack action passes on the new connection",
    check: r9,
  },
  { id: "R10", phase: 3, title: "Connect shows one Slack entry", check: r10 },
  { id: "R11", phase: 1, title: "Lower layers stay ignorant", check: r11 },
  {
    id: "R12",
    phase: 2,
    title: "A member who is not the guardian is answered as a visitor",
    check: r12,
  },
  { id: "R13", phase: 2, title: "Slack holds what was said", check: r13 },
  { id: "R14", phase: 3, title: "Groups the app was added to", check: r14 },
];

// Order matters: R3 and the second binding need R1's connection; R7 reads
// R4's messages; R6 stops the instance; R8 removes the app and disconnects,
// so it runs after the rest; R14 signs workspace B in again on the second
// instance under the old scopes and back, before R8; R2 then signs the first instance in to a third
// workspace. R10 seeds the old connections on the second instance, whose
// connector token file would turn R9's path to the old one, so it runs last.
const ORDER = ["R11", "R1", "R3", "bindB", "R4", "R7", "R5", "R12", "R13", "R9", "R14", "R6", "R8", "R2", "R10"];

const [envPath, outDir, verifierCommit] = process.argv.slice(2);
const env = loadEnv(envPath);
setReachSeconds(env.timeouts.reachSeconds);
const slack = fakeSlack(env.slack.control.replace(/\/$/, ""));
// Workspace A binds to the first instance and B to the second. Each
// workspace's guardian is its owner.
// R2's workspace is any other one that is not the app's home workspace.
const fakeState = await slack.state();
const workspaces = fakeState.workspaces.map((w) => ({
  id: w.id,
  guardian: (w.members.find((m) => m.guardian || m.is_owner) ?? w.members[0]).id,
}));
const homeTeam = fakeState.distribution?.home_team ?? null;
const ctx = {
  env,
  slack,
  a: instance(env.instances[0], slack.origin, env.timeouts),
  b: instance(env.instances[1], slack.origin, env.timeouts),
  wsA: workspaces[0],
  wsB: workspaces[1],
  wsC: workspaces.slice(2).find((w) => homeTeam && w.id !== homeTeam) ?? null,
  homeTeam,
  bound: { a: null, b: null },
};

// VERIFIER_ONLY (run.sh --only) scores a subset: rule ids, or phase1 to
// phase3. R1 and the second binding still run, since every later rule needs
// their connections; R3 runs when R1 does, as in the full order.
const only = selection(process.env.VERIFIER_ONLY);
const minFreeMiB = Number(process.env.VERIFIER_MIN_FREE_GB || 0) * 1024;
const memoryWaitMs = Number(process.env.VERIFIER_MEMORY_WAIT_SECONDS || 1800) * 1000;

const startedAt = new Date().toISOString();
const results = {};
const setup = {};
for (const step of ORDER) {
  const started = Date.now();
  if (step === "bindB") {
    const walk = await connectAs(ctx, ctx.b, ctx.wsB).catch((e) => ({
      outcome: "stuck",
      reason: e.message,
    }));
    if (walk.outcome === "connected") ctx.bound.b = walk.connectionId ?? true;
    setup.secondBinding = {
      instance: ctx.b.name,
      workspace: ctx.wsB.id,
      outcome: walk.outcome,
      reason: walk.reason,
    };
    log(`second instance to ${ctx.wsB.id}: ${walk.outcome}`);
    continue;
  }
  const rule = RULES.find((r) => r.id === step);
  if (only && !only.has(rule.id) && rule.id !== "R1") {
    results[rule.id] = { result: "not checked", reason: `not selected (--only ${process.env.VERIFIER_ONLY})`, seconds: 0 };
    continue;
  }
  // Below the free-memory line, the rule waits for the machine rather than
  // start in a spell when Rome holds its turns.
  if (minFreeMiB) {
    const waitStarted = Date.now();
    let m = hostMemory();
    if (m && m.availableMiB < minFreeMiB) log(`${rule.id} waits: ${m.availableMiB} MiB free, line ${minFreeMiB} MiB`);
    while (m && m.availableMiB < minFreeMiB && Date.now() - waitStarted < memoryWaitMs) {
      await new Promise((r) => setTimeout(r, 15_000));
      m = hostMemory();
    }
    if (m && m.availableMiB < minFreeMiB) {
      results[rule.id] = {
        result: "not checked",
        reason: `machine short on memory before the rule: ${m.availableMiB} MiB free after waiting ${Math.round(memoryWaitMs / 1000)} s, under the ${minFreeMiB} MiB line`,
        memory: { atStart: m, waitedSeconds: Math.round((Date.now() - waitStarted) / 1000) },
        seconds: Math.round((Date.now() - started) / 1000),
      };
      log(`${rule.id}: ${results[rule.id].result} (${results[rule.id].reason})`);
      continue;
    }
    setup.memoryWaits ??= {};
    if (Date.now() - waitStarted > 1000) setup.memoryWaits[rule.id] = Math.round((Date.now() - waitStarted) / 1000);
  }
  log(`${rule.id} ${rule.title} ...`);
  resetTrail();
  const memoryAtStart = hostMemory();
  const warnedBefore = await shortOnMemory([ctx.a, ctx.b]);
  try {
    results[rule.id] = await rule.check(ctx);
  } catch (err) {
    results[rule.id] = crashed(err);
  }
  const warned = warnedDuring(warnedBefore, await shortOnMemory([ctx.a, ctx.b]));
  results[rule.id].memory = { atStart: memoryAtStart, shortOnMemoryWarnings: warned };
  // Rome held its turns while the machine was short on memory: a rule that
  // did not pass then measured the machine. A pass stands.
  if (Object.keys(warned).length && results[rule.id].result !== "pass") {
    const [name, lines] = Object.entries(warned)[0];
    const was = results[rule.id];
    results[rule.id] = {
      result: "not checked",
      reason: `machine short on memory: ${name} logged "${lines.at(-1).slice(0, 200)}" during the rule (otherwise ${was.result}: ${was.reason})`,
      evidence: was.evidence,
      memory: was.memory,
    };
  }
  results[rule.id].seconds = Math.round((Date.now() - started) / 1000);
  log(`${rule.id}: ${results[rule.id].result} (${results[rule.id].reason})`);
}

const report = {
  ruleSet: "v3",
  phases: [1, 2, 3],
  startedAt,
  finishedAt: new Date().toISOString(),
  commits: {
    rome: env.commits.rome,
    romeCloud: env.commits.romeCloud,
    environment: env.commits.environment,
    verifier: verifierCommit,
  },
  model: env.model,
  differences: env.differences ?? null,
  setup,
  only: only ? [...only] : null,
  minFreeGB: minFreeMiB ? minFreeMiB / 1024 : null,
  rules: RULES.map((r) => ({
    id: r.id,
    title: r.title,
    phase: r.phase,
    ...(r.check
      ? results[r.id]
      : { result: "not checked", reason: `Phase ${r.phase} rule; this verifier does not score it yet.` }),
  })),
};
mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
writeFileSync(join(outDir, "report.md"), markdown(report));
const failed = report.rules.filter((r) => r.result === "fail").map((r) => r.id);
log(`report: ${join(outDir, "report.md")}; failed: ${failed.join(", ") || "none"}`);
process.exit(failed.length ? 1 : 0);

/**
 * A check that threw. An endpoint that never answered leaves the rule not
 * checked, naming what could not be reached; any other error fails it, with
 * its cause chain and the requests just before.
 */
function crashed(err) {
  const trail = lastRequests();
  if (err instanceof Unreachable)
    return {
      result: "not checked",
      reason: err.message,
      evidence: { unreachable: err.info, lastRequests: trail.requests },
    };
  const causes = [];
  for (let e = err.cause; e && causes.length < 4; e = e.cause) causes.push(`${e.code ?? e.name}: ${e.message}`);
  return {
    result: "fail",
    reason: `the check crashed${trail.phase ? ` during "${trail.phase}"` : ""}: ${err.message}`,
    evidence: { stack: err.stack, causes, phase: trail.phase, lastRequests: trail.requests },
  };
}

/** The rule ids `spec` names ("R14,R9", "phase3"), or null for every rule. */
function selection(spec) {
  if (!spec) return null;
  const ids = new Set();
  for (const part of spec.split(",").map((x) => x.trim()).filter(Boolean)) {
    const ph = part.match(/^phase:?([123])$/i);
    if (ph) for (const r of RULES.filter((x) => x.phase === Number(ph[1]))) ids.add(r.id);
    else if (RULES.some((r) => r.id === part.toUpperCase())) ids.add(part.toUpperCase());
    else throw new Error(`--only: no rule or phase named ${part}`);
  }
  if (ids.has("R1")) ids.add("R3");
  return ids;
}

function log(msg) {
  process.stderr.write(`[verifier ${new Date().toISOString().slice(11, 19)}] ${msg}\n`);
}

function markdown(r) {
  const mark = { pass: "pass", fail: "FAIL", "not checked": "not checked" };
  const rows = r.rules.map(
    (x) => `| ${x.id} | ${x.title} | ${mark[x.result]} | ${x.reason.replaceAll("|", "\\|")} |`,
  );
  const evidence = r.rules
    .filter((x) => x.evidence)
    .map((x) => `### ${x.id}\n\n\`\`\`json\n${JSON.stringify(x.evidence, null, 2)}\n\`\`\``);
  return [
    `# Slack app verifier report, rule set ${r.ruleSet}, phases ${r.phases.join(", ")}`,
    "",
    `- rome: \`${r.commits.rome}\``,
    `- rome-cloud: \`${r.commits.romeCloud}\``,
    `- environment: \`${r.commits.environment}\``,
    `- verifier: \`${r.commits.verifier}\``,
    `- model: ${r.model}`,
    `- run: ${r.startedAt} to ${r.finishedAt}`,
    r.differences ? `- differences from production: ${JSON.stringify(r.differences)}` : "",
    "",
    "| Rule | Title | Result | Reason |",
    "|---|---|---|---|",
    ...rows,
    "",
    "## Evidence",
    "",
    ...evidence,
    "",
  ].join("\n");
}
