// Scores rule set v5 on the slack-gateway Worker's side, with the verifier's
// stand-in instance (gateway/agent.mjs) in place of Rome, until Rome's side
// of the Worker's contract lands. A rule's part that only Rome can show is
// named "needs the Rome side", and R1, R2, R10 and R14 are not checked.
// Usage: node worker.mjs <env.json> <out dir> <verifier commit>. run.sh
// --worker is the entry point.

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadEnv } from "./lib/env.mjs";
import { gatewayInstance } from "./lib/gateway.mjs";
import { lastRequests, resetTrail, setReachSeconds, Unreachable } from "./lib/http.mjs";
import { fakeSlack } from "./lib/slack.mjs";
import { r11 } from "./rules/structure.mjs";
import { r3, r4, r5, r6, r7, r8, r9, r15, romeOnly, setup } from "./rules/worker.mjs";

const RULES = [
  { id: "R1", group: "Access", title: "One sign-in" },
  { id: "R2", group: "Access", title: "Any workspace" },
  { id: "R3", group: "Access", title: "One workspace, one instance", check: r3 },
  { id: "R8", group: "Access", title: "Broken, fixed, disconnected", check: r8 },
  { id: "R10", group: "Access", title: "One Slack entry" },
  { id: "R4", group: "Hear", title: "Direct messages", check: r4 },
  { id: "R5", group: "Hear", title: "Mentions", check: r5 },
  { id: "R6", group: "Hear", title: "While Rome is down", check: r6 },
  { id: "R7", group: "Hear", title: "Forged and misrouted", check: r7 },
  { id: "R9", group: "Speak and act", title: "Send and read, nothing else", check: r9 },
  { id: "R15", group: "Speak and act", title: "The token stays in Rome Cloud", check: r15 },
  { id: "R14", group: "Speak and act", title: "Groups" },
  { id: "R11", group: "Structure", title: "Layers", check: (ctx) => r11(ctx, { v5: true }) },
];
// R7 reads R4's events; R15 searches every answer before it; R8 removes and
// disconnects workspace A, so it runs last.
const ORDER = ["R11", "setup", "R3", "R9", "R4", "R5", "R7", "R6", "R15", "R8"];

const [envPath, outDir, verifierCommit] = process.argv.slice(2);
const env = loadEnv(envPath);
setReachSeconds(env.timeouts.reachSeconds);
const slack = fakeSlack(env.slack.control.replace(/\/$/, ""));
const fakeState = await slack.state();
const workspaces = fakeState.workspaces.map((w) => ({
  id: w.id,
  guardian: (w.members.find((m) => m.guardian || m.is_owner) ?? w.members[0]).id,
}));

/** A stand-in instance with the environment's find_secret control on it. */
const standIn = (conf) => gatewayInstance(conf.name, conf.control.asInstance, { findSecret: conf.control.findSecret ?? null });

const ctx = {
  env,
  slack,
  a: standIn(env.instances[0]),
  b: standIn(env.instances[1]),
  wsA: workspaces[0],
  wsB: workspaces[1],
  bound: { a: null, b: null },
  runSince: await slack.seq(),
};
ctx.instances = [ctx.a, ctx.b];

const only = process.env.VERIFIER_ONLY ? new Set(process.env.VERIFIER_ONLY.split(",").map((x) => x.trim().toUpperCase())) : null;
const startedAt = new Date().toISOString();
const results = {};
const setupOut = {};
for (const [id, why] of Object.entries(romeOnly))
  results[id] = { result: "not checked", reason: `needs the Rome side: ${why}` };
if (!env.instances[0].control.asInstance || !env.instances[1].control.asInstance) {
  for (const r of RULES.filter((x) => x.check && x.id !== "R11"))
    results[r.id] = { result: "not checked", reason: "the environment gives no as_instance control to run the stand-in instance" };
}
for (const step of ORDER) {
  const started = Date.now();
  if (step === "setup") {
    if (!env.instances[0].control.asInstance) continue;
    try {
      Object.assign(setupOut, await setup(ctx));
    } catch (err) {
      setupOut.error = err.message;
    }
    log(`stand-in instances: ${JSON.stringify(setupOut)}`);
    continue;
  }
  const rule = RULES.find((r) => r.id === step);
  if (results[rule.id]) continue;
  if (only && !only.has(rule.id)) {
    results[rule.id] = { result: "not checked", reason: `not selected (--only ${process.env.VERIFIER_ONLY})` };
    continue;
  }
  log(`${rule.id} ${rule.title} ...`);
  resetTrail();
  try {
    results[rule.id] = await rule.check(ctx);
  } catch (err) {
    results[rule.id] = crashed(err);
  }
  results[rule.id].seconds = Math.round((Date.now() - started) / 1000);
  log(`${rule.id}: ${results[rule.id].result} (${results[rule.id].reason})`);
}

const report = {
  ruleSet: "v5, the slack-gateway Worker's side, with the verifier's stand-in instance",
  startedAt,
  finishedAt: new Date().toISOString(),
  commits: {
    rome: env.commits.rome,
    romeCloud: env.commits.romeCloud,
    environment: env.commits.environment,
    verifier: verifierCommit,
  },
  instance: "the verifier's stand-in (gateway/agent.mjs), run as each instance through as_instance",
  differences: env.differences ?? null,
  setup: setupOut,
  rules: RULES.map((r) => ({ id: r.id, title: r.title, group: r.group, ...results[r.id] })),
};
mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
writeFileSync(join(outDir, "report.md"), markdown(report));
const failed = report.rules.filter((r) => r.result === "fail").map((r) => r.id);
log(`report: ${join(outDir, "report.md")}; failed: ${failed.join(", ") || "none"}`);
process.exit(failed.length ? 1 : 0);

function crashed(err) {
  const trail = lastRequests();
  if (err instanceof Unreachable)
    return { result: "not checked", reason: err.message, evidence: { unreachable: err.info, lastRequests: trail.requests } };
  return {
    result: "fail",
    reason: `the check crashed${trail.phase ? ` during "${trail.phase}"` : ""}: ${err.message}`,
    evidence: { stack: err.stack, lastRequests: trail.requests },
  };
}

function log(msg) {
  process.stderr.write(`[worker verifier ${new Date().toISOString().slice(11, 19)}] ${msg}\n`);
}

function markdown(r) {
  const mark = { pass: "pass", fail: "FAIL", "not checked": "not checked" };
  return [
    `# Slack app verifier report, rule set ${r.ruleSet}`,
    "",
    `- rome-cloud: \`${r.commits.romeCloud}\``,
    `- environment: \`${r.commits.environment}\``,
    `- verifier: \`${r.commits.verifier}\``,
    `- rome: \`${r.commits.rome}\` (not under test: the instance is the verifier's stand-in)`,
    `- run: ${r.startedAt} to ${r.finishedAt}`,
    "",
    "| Rule | Group | Title | Result | Reason |",
    "|---|---|---|---|---|",
    ...r.rules.map((x) => `| ${x.id} | ${x.group} | ${x.title} | ${mark[x.result]} | ${String(x.reason).replaceAll("|", "\\|")} |`),
    "",
    "## Evidence",
    "",
    ...r.rules.filter((x) => x.evidence).map((x) => `### ${x.id}\n\n\`\`\`json\n${JSON.stringify(x.evidence, null, 2)}\n\`\`\``),
    "",
  ].join("\n");
}
