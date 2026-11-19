// Scores the official Slack app against rule set v2, phases 1 to 3, in one
// environment. Usage: node verify.mjs <env.json> <out dir> <verifier commit>.
// run.sh is the entry point: it refuses uncommitted verifier code first.

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadEnv } from "./lib/env.mjs";
import { instance } from "./lib/instance.mjs";
import { fakeSlack } from "./lib/slack.mjs";
import { r4, r6, r7 } from "./rules/chat.mjs";
import { connectAs, r1, r2, r3 } from "./rules/connect.mjs";
import { r5, r8, r12, r13 } from "./rules/phase2.mjs";
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
  { id: "R9", phase: 3, title: "Every connector Slack action passes on the new connection" },
  { id: "R10", phase: 3, title: "Connect shows one Slack entry" },
  { id: "R11", phase: 1, title: "Lower layers stay ignorant", check: r11 },
  {
    id: "R12",
    phase: 2,
    title: "A member who is not the guardian is answered as a visitor",
    check: r12,
  },
  { id: "R13", phase: 2, title: "Slack holds what was said", check: r13 },
];

// Order matters: R3 and the second binding need R1's connection; R7 reads
// R4's messages; R6 stops the instance; R8 removes the app and disconnects,
// so it runs after the rest; R2 then signs the first instance in to a third
// workspace.
const ORDER = ["R11", "R1", "R3", "bindB", "R4", "R7", "R5", "R12", "R13", "R6", "R8", "R2"];

const [envPath, outDir, verifierCommit] = process.argv.slice(2);
const env = loadEnv(envPath);
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
  a: instance(env.instances[0], slack.origin),
  b: instance(env.instances[1], slack.origin),
  wsA: workspaces[0],
  wsB: workspaces[1],
  wsC: workspaces.slice(2).find((w) => homeTeam && w.id !== homeTeam) ?? null,
  homeTeam,
  bound: { a: null, b: null },
};

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
  log(`${rule.id} ${rule.title} ...`);
  try {
    results[rule.id] = await rule.check(ctx);
  } catch (err) {
    results[rule.id] = {
      result: "fail",
      reason: `the check crashed: ${err.message}`,
      evidence: { stack: err.stack },
    };
  }
  results[rule.id].seconds = Math.round((Date.now() - started) / 1000);
  log(`${rule.id}: ${results[rule.id].result} (${results[rule.id].reason})`);
}

const report = {
  ruleSet: "v2",
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
