// Proves the Worker verifier (worker.mjs) before it scores the real Worker:
// against the good stand-in Worker every Worker-side rule must pass, and
// against each broken one the rule it breaks must fail.
//
// Usage: node prove-worker.mjs [git ref of the environment, default
// origin/slack-official-app/environment-gateway]. Writes
// out/proof-worker/summary.md. PROVE_CASES names a subset of cases.

import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const here = fileURLToPath(new URL(".", import.meta.url));
const ref = process.argv[2] ?? "origin/slack-official-app/environment-gateway";
const out = join(here, "out/proof-worker");
rmSync(out, { recursive: true, force: true });
mkdirSync(join(out, "fake-slack"), { recursive: true });
const show = (path) => execFileSync("git", ["-C", here, "show", `${ref}:${path}`]);
writeFileSync(join(out, "fake-slack/server.mjs"), show("environments/slack-app/fake-slack/server.mjs"));
writeFileSync(join(out, "fake-slack/workspaces.json"), show("environments/slack-app/config/workspaces.json"));
const envCommit = execFileSync("git", ["-C", here, "rev-parse", ref]).toString().trim();
const dirty = execFileSync("git", ["-C", here, "status", "--porcelain", "--", "."]).toString().trim();
const commit = `${execFileSync("git", ["-C", here, "rev-parse", "HEAD"]).toString().trim()}${dirty ? "+uncommitted" : ""}`;

const SCORED = ["R3", "R4", "R5", "R6", "R7", "R8", "R9", "R11", "R15"];
const ROME_ONLY = ["R1", "R2", "R10", "R14"];
const CASES = [
  { name: "good", breaks: "", expect: "every Worker-side rule passes; R1, R2, R10 and R14 need the Rome side" },
  { name: "W-R3-takeover", breaks: "W-R3-takeover", rule: "R3", what: "a second instance takes a bound workspace" },
  { name: "W-R4-drop", breaks: "W-R4-drop", rule: "R4", what: "every fourth event is answered 200 but never deposited" },
  { name: "W-R5-thread", breaks: "W-R5-thread", rule: "R5", what: "a mention in a thread loses its thread" },
  { name: "W-R6-expire", breaks: "W-R6-expire", rule: "R6", what: "the mailbox drops a delivery left 20 s" },
  { name: "W-R7-signature", breaks: "W-R7-signature", rule: "R7", what: "events with a bad signature are deposited" },
  { name: "W-R7-route", breaks: "W-R7-route", rule: "R7", what: "every event goes to every instance's mailbox" },
  { name: "W-R8-uninstall", breaks: "W-R8-uninstall", rule: "R8", what: "removing the app in Slack leaves the workspace bound" },
  { name: "W-R8-keep-token", breaks: "W-R8-keep-token", rule: "R8", what: "disconnecting leaves the token working at Slack" },
  { name: "W-R8-held", breaks: "W-R8-held", rule: "R8", what: "disconnecting leaves the workspace bound, so no other instance can take it" },
  { name: "W-R9-any", breaks: "W-R9-any", rule: "R9", what: "the Worker calls any method it is asked for" },
  { name: "W-R15-token", breaks: "W-R15-token", rule: "R15", what: "the workspace list sent to the instance carries the bot token" },
  { name: "W-R15-deposit", breaks: "W-R15-deposit", rule: "R15", what: "each delivery carries the bot token in a header" },
  { name: "W-R15-log", breaks: "W-R15-log", rule: "R15", what: "the Worker logs the bot token" },
  { name: "W-R15-stored", breaks: "W-R15-stored", rule: "R15", what: "instance a's database holds the bot tokens, found by find_secret" },
  { name: "W-R15-cross", breaks: "W-R15-cross", rule: "R15", what: "another instance's calls in a bound workspace reach Slack" },
  { name: "W-R11-message", breaks: "W-R11-message", rule: "R11", what: "the Worker's workspaces table keeps a message's text" },
  { name: "W-R11-relay", breaks: "W-R11-relay", rule: "R11", what: "the relay gains Slack code" },
];

const rows = [];
let ok = true;
const only = (process.env.PROVE_CASES ?? "").split(",").filter(Boolean);
for (const c of CASES.filter((x) => !only.length || only.includes(x.name))) {
  const work = join(out, c.name);
  const world = spawn(process.execPath, [join(here, "standin/worker-up.mjs"), join(out, "fake-slack"), work], {
    stdio: ["ignore", "inherit", "inherit"],
    env: { ...process.env, BREAK: c.breaks },
  });
  const envPath = join(work, "env.json");
  for (let i = 0; i < 300 && !existsSync(envPath); i++) await new Promise((r) => setTimeout(r, 100));
  const env = JSON.parse(readFileSync(envPath, "utf8"));
  env.commits.environment = `${envCommit} (fake Slack only)`;
  writeFileSync(envPath, JSON.stringify(env, null, 2));
  await new Promise((r) => {
    spawn(process.execPath, [join(here, "worker.mjs"), envPath, join(work, "report"), commit], {
      stdio: ["ignore", "inherit", "inherit"],
      env: { ...process.env, ...(c.env ?? {}) },
    }).on("exit", r);
  });
  world.kill("SIGTERM");
  await new Promise((r) => world.on("exit", r));
  const report = JSON.parse(readFileSync(join(work, "report/report.json"), "utf8"));
  const result = Object.fromEntries(report.rules.map((r) => [r.id, r.result]));
  const proved = c.rule
    ? result[c.rule] === (c.result ?? "fail")
    : SCORED.every((id) => result[id] === "pass") && ROME_ONLY.every((id) => result[id] === "not checked");
  ok &&= proved;
  rows.push(`| ${c.name} | ${c.rule ? `${c.rule} ${c.result ?? "fail"}: ${c.what}` : c.expect} | ${[...SCORED].map((id) => result[id]).join(" | ")} | ${proved ? "yes" : "NO"} |`);
  if (c.rule) rows.push(`|  | ${report.rules.find((r) => r.id === c.rule).reason.replaceAll("|", "\\|")} |${" |".repeat(SCORED.length + 1)}`);
  else for (const r of report.rules.filter((x) => x.result !== "pass" || true)) rows.push(`|  | ${r.id}: ${String(r.reason).replaceAll("|", "\\|")} |${" |".repeat(SCORED.length + 1)}`);
}
const summary = [
  "# Worker verifier proof",
  "",
  `- verifier: \`${commit}\``,
  `- fake Slack: \`${envCommit}\``,
  "",
  `| Case | Expected | ${SCORED.join(" | ")} | Proved |`,
  `|---|---|${SCORED.map(() => "---").join("|")}|---|`,
  ...rows,
  "",
  ok ? "Every case proved." : "Some cases were NOT proved.",
  "",
].join("\n");
writeFileSync(join(out, "summary.md"), summary);
process.stdout.write(summary);
process.exit(ok ? 0 : 1);
