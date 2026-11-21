// Proves the verifier before the product exists: runs it against the good
// stand-in, where every scored rule of rule set v4 must pass, and against
// each broken stand-in, where the rule it breaks must fail (or, where the
// case says, report "not checked" or still pass).
//
// Usage: node prove.mjs [git ref of the environment, default
// origin/slack-official-app/environment]. Writes out/proof/summary.md.
// PROVE_CASES names a subset of cases to run.

import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const here = fileURLToPath(new URL(".", import.meta.url));
const ref = process.argv[2] ?? "origin/slack-official-app/environment";
const out = join(here, "out/proof");
// One proof at a time per checkout: a second one would wipe the first's
// instance state files under out/proof mid-run.
const lock = join(here, "out/proof.lock");
mkdirSync(join(here, "out"), { recursive: true });
if (existsSync(lock)) {
  const pid = Number(readFileSync(lock, "utf8"));
  let alive = false;
  try {
    process.kill(pid, 0);
    alive = true;
  } catch {}
  if (alive) {
    process.stderr.write(`prove.mjs: another proof (pid ${pid}) is running in this checkout\n`);
    process.exit(2);
  }
}
writeFileSync(lock, String(process.pid));
process.on("exit", () => rmSync(lock, { force: true }));
rmSync(out, { recursive: true, force: true });
mkdirSync(join(out, "fake-slack"), { recursive: true });

// The environment's own fake Slack, so the stand-in speaks its real control API.
const show = (path) => execFileSync("git", ["-C", here, "show", `${ref}:${path}`]);
writeFileSync(
  join(out, "fake-slack/server.mjs"),
  show("environments/slack-app/fake-slack/server.mjs"),
);
writeFileSync(
  join(out, "fake-slack/workspaces.json"),
  show("environments/slack-app/config/workspaces.json"),
);
const envCommit = execFileSync("git", ["-C", here, "rev-parse", ref]).toString().trim();
const dirty = execFileSync("git", ["-C", here, "status", "--porcelain", "--", "."])
  .toString()
  .trim();
const commit = `${execFileSync("git", ["-C", here, "rev-parse", "HEAD"]).toString().trim()}${dirty ? "+uncommitted" : ""}`;

// The scored rules of rule set v4, and the smoke check shown beside them.
const SCORED = ["R1", "R2", "R3", "R4", "R5", "R6", "R7", "R8", "R9", "R10", "R11", "R14"];
const SHOWN = [...SCORED, "smoke"];
const CASES = [
  { name: "good", breaks: "", expect: "every scored rule passes" },
  {
    name: "no-port",
    breaks: "",
    standin: { STANDIN_NO_PORT: "1" },
    want: { R9: "not checked", R10: "not checked", R14: "not checked" },
    expect: "without the port and record controls (as on main): R9, R14 and R10's send naming no sender not checked, the rest pass, R1 through Rome's reply",
  },
  { name: "R1-fields", breaks: "R1-fields", rule: "R1", what: "setup asks for a bot token and a signing secret" },
  {
    name: "continue",
    breaks: "continue",
    rule: "R1",
    result: "pass",
    what: "Connect shows a Continue screen of Rome's own, a GET form with nothing to fill",
  },
  { name: "R1-twice", breaks: "R1-twice", rule: "R1", what: "Connect sends the guardian through the Slack sign-in twice" },
  { name: "R1-kept", breaks: "R1-kept", rule: "R1", what: "Rome Cloud keeps the sign-in's outcome after the instance redeemed it" },
  { name: "R1-account", breaks: "R1-account", rule: "R1", what: "the connection's account does not name the workspace" },
  { name: "silent", breaks: "silent", rule: "smoke", what: "the Concierge never replies: the smoke check fails, the rules do not" },
  {
    name: "silent-no-port",
    breaks: "silent",
    standin: { STANDIN_NO_PORT: "1" },
    rule: "R1",
    what: "without a port, R1's send is Rome's reply, so a silent Concierge fails R1",
  },
  { name: "R2-own-only", breaks: "R2-own-only", rule: "R2", what: "Rome Cloud connects only the team's own workspaces (A and B)" },
  { name: "R3", breaks: "R3", rule: "R3", what: "Rome Cloud lets a second instance take a bound workspace" },
  {
    name: "R4-early-ack",
    breaks: "R4-early-ack",
    rule: "R4",
    what: "the instance acknowledges its mailbox before it records, so a stop mid-burst loses messages",
  },
  { name: "R4-twice", breaks: "DUP-answers-twice", rule: "R4", what: "a redelivered event is recorded again" },
  { name: "R5-unrecorded", breaks: "R5-unrecorded", rule: "R5", what: "mentions are answered but never recorded" },
  { name: "R5-thread", breaks: "R5-thread", rule: "R5", what: "a mention in a thread is recorded under another thread" },
  { name: "R5-top", breaks: "R5-top", rule: "R5", what: "a send to a thread lands at the top of the group" },
  { name: "R6", breaks: "R6", rule: "R6", what: "the instance throws away its mailbox when it starts" },
  { name: "R6-drop5", breaks: "R6-drop5", rule: "R6", what: "5 of the 20 messages waiting at restart are lost" },
  {
    name: "R6-stop-error",
    breaks: "R6-stop-error",
    rule: "R6",
    result: "pass",
    what: "the stop control stops the instance, then reports a failure",
  },
  { name: "R7-signature", breaks: "R7-signature", rule: "R7", what: "Rome Cloud skips Slack's signature check" },
  { name: "R7-route", breaks: "R7-route", rule: "R7", what: "Rome Cloud delivers every event to every bound instance" },
  { name: "R7-quiet", breaks: "R7-signature,R7-quiet", rule: "R7", what: "forged events get through and are answered with no code" },
  {
    name: "R7-elsewhere",
    breaks: "R7-signature,R7-elsewhere",
    rule: "R7",
    what: "forged events get through, go unrecorded and are answered in another direct message",
  },
  {
    name: "R7-transport",
    breaks: "R7-transport",
    rule: "R7",
    result: "not checked",
    what: "every forged event is dropped on the way to Rome Cloud",
  },
  { name: "R7-gateway", breaks: "R7-gateway", rule: "R7", result: "not checked", what: "a gateway answers 502 to every forged event" },
  {
    name: "R7-blind",
    breaks: "R7-route,R7-blind",
    rule: "R7",
    what: "the wrong instance answers workspace A's events in its own workspace, naming nothing of A",
  },
  {
    name: "R7-lookup",
    breaks: "R7-route,R7-lookup",
    rule: "R7",
    what: "the wrong instance looks up workspace A's sender, then drops the event",
  },
  { name: "R8-never", breaks: "R8-never", rule: "R8", what: "removing the app never marks the connection broken" },
  { name: "R8-new-account", breaks: "R8-new-account", rule: "R8", what: "the repair gives a new connected account" },
  { name: "R8-keep-token", breaks: "R8-keep-token", rule: "R8", what: "disconnecting in Rome leaves the token working" },
  { name: "R9-other-method", breaks: "R9-other-method", rule: "R9", what: "the port calls any Slack method it is asked for" },
  { name: "R9-no-read", breaks: "R9-no-read", rule: "R9", what: "a read through the port answers nothing" },
  { name: "R9-extra-call", breaks: "R9-extra-call", rule: "R9", what: "the instance lists the workspace's members on connect" },
  { name: "R10-two-entries", breaks: "R10-two-entries", rule: "R10", what: "Connect offers Slack bot beside Slack" },
  { name: "R10-bot-connects", breaks: "R10-bot-connects", rule: "R10", what: "a new slack_bot setup can still start" },
  { name: "R10-oauth-connects", breaks: "R10-oauth-connects", rule: "R10", what: "the old OAuth start still sends the guardian to Slack" },
  { name: "R10-old-works", breaks: "R10-old-works", rule: "R10", what: "the stored old connections are listed and the older bot still answers" },
  { name: "R10-two-senders", breaks: "R10-two-senders", rule: "R10", env: { VERIFIER_ONLY: "R10" }, what: "a stored old row counts as a second Slack sender, so a send naming no sender is refused" },
  { name: "R10-sender-choice", breaks: "R10-sender-choice", rule: "R10", env: { VERIFIER_ONLY: "R10" }, what: "a send naming no sender is answered with the senders to choose from" },
  { name: "R10-old-sender", breaks: "R10-old-sender", rule: "R10", env: { VERIFIER_ONLY: "R10" }, what: "a send naming no sender goes out with the older bot's token" },
  { name: "R10-restart-loses", breaks: "R10-restart-loses", rule: "R10", env: { VERIFIER_ONLY: "R10" }, what: "the stored old rows are deleted at the restart" },
  { name: "R10-log-error", breaks: "R10-log-error", rule: "R10", env: { VERIFIER_ONLY: "R10" }, what: "Rome logs an error for each stored old row" },
  { name: "R10-no-warn", breaks: "R10-no-warn", rule: "R10", env: { VERIFIER_ONLY: "R10" }, what: "Rome skips the stored old rows without a warning" },
  { name: "only-R10", breaks: "", rule: "R10", result: "pass", env: { VERIFIER_ONLY: "R10" }, what: "--only R10 scores R10 after R1 and the second binding" },
  { name: "dm-only", breaks: "dm-only", rule: "R14", result: "not checked", what: "the app as built asks for no group history" },
  { name: "R14-lists-all", breaks: "R14-lists-all", rule: "R14", what: "the list of groups names #quiet, which the app is not in" },
  { name: "R14-quiet-read", breaks: "R14-quiet-read", rule: "R14", what: "a read of #quiet shows its messages" },
  { name: "R14-no-thread", breaks: "R14-no-thread", rule: "R14", what: "a thread read answers nothing" },
  { name: "R14-hears-all", breaks: "R14-hears-all", rule: "R14", what: "a plain group message is heard and recorded" },
  { name: "R14-no-reapprove", breaks: "R14-no-reapprove", rule: "R14", what: "under the old scopes the connection does not say it needs approving again" },
  { name: "own-pace", breaks: "own-pace", rule: "R14", result: "pass", env: { VERIFIER_ONLY: "R9,R14" }, what: "the port paces reads at one per 90 s and says when to try again; each refused read is waited out and passes" },
  { name: "own-pace-R9", breaks: "own-pace", rule: "R9", result: "pass", env: { VERIFIER_ONLY: "R9,R14" }, what: "R9's read under the same pace" },
  { name: "R14-pace-long", breaks: "R14-pace-long", rule: "R14", env: { VERIFIER_ONLY: "R9,R14" }, what: "a thread read is refused with a wait past the 150 s cap" },
  { name: "only-R14", breaks: "", rule: "R14", result: "pass", env: { VERIFIER_ONLY: "R14" }, what: "--only R14 scores R14 after R1 and the second binding; the rest are not checked" },
  {
    name: "memory-line",
    breaks: "",
    rule: "R14",
    result: "not checked",
    env: { VERIFIER_ONLY: "R14", VERIFIER_MIN_FREE_GB: "100000", VERIFIER_MEMORY_WAIT_SECONDS: "20" },
    what: "under the free-memory line R14 waits, then is not checked",
  },
  { name: "R11", breaks: "R11", rule: "R11", what: "the relay gains a Slack file" },
  { name: "R11-namespace", breaks: "R11-namespace", rule: "R11", what: "a Drizzle schema from a namespace import (`pg.text`) stores the bot token" },
  { name: "R11-message", breaks: "R11-message", rule: "R11", what: "Rome Cloud stores message content" },
  { name: "R11-member", breaks: "R11-member", rule: "R11", what: "Rome Cloud stores Slack member data" },
  { name: "R11-token-kept", breaks: "R11-token-kept", rule: "R11", what: "the sign-in attempt's outcome is never cleared on redemption" },
  { name: "R11-no-sweep", breaks: "R11-no-sweep", rule: "R11", what: "nothing deletes expired sign-in attempts" },
  { name: "R11-import", breaks: "R11-import", rule: "R11", what: "the product adds an import from an app in core's connections" },
  { name: "R11-eof", breaks: "R11-eof", rule: "R11", what: "a CREATE TABLE with no semicolon at the end of the file stores the bot token" },
  { name: "R11-migration", breaks: "R11-migration", rule: "R11", what: "a migration adds a bot token column" },
  { name: "R11-sql", breaks: "R11-sql", rule: "R11", what: "a one-line CREATE TABLE stores the bot token" },
  { name: "R11-store", breaks: "R11-store", rule: "R11", what: "Rome Cloud stores the bot token" },
];

const rows = [];
let ok = true;
// PROVE_CASES=good,R7-name runs only the named cases, for a quick re-check.
const only = (process.env.PROVE_CASES ?? "").split(",").filter(Boolean);
for (const c of CASES.filter((x) => !only.length || only.includes(x.name))) {
  const work = join(out, c.name);
  const world = spawn(
    process.execPath,
    [join(here, "standin/up.mjs"), join(out, "fake-slack"), work],
    {
      stdio: ["ignore", "inherit", "inherit"],
      env: { ...process.env, BREAK: c.breaks, ...(c.standin ?? {}) },
    },
  );
  const envPath = join(work, "env.json");
  for (let i = 0; i < 100 && !existsSync(envPath); i++)
    await new Promise((r) => setTimeout(r, 100));
  const env = JSON.parse(readFileSync(envPath, "utf8"));
  env.commits.environment = `${envCommit} (fake Slack only)`;
  writeFileSync(envPath, JSON.stringify(env, null, 2));
  await new Promise((r) => {
    spawn(process.execPath, [join(here, "verify.mjs"), envPath, join(work, "report"), commit], {
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
    : SCORED.every((id) => result[id] === (c.want?.[id] ?? "pass"));
  ok &&= proved;
  rows.push(
    `| ${c.name} | ${c.rule ? `${c.rule} ${c.result ?? "fail"}: ${c.what}` : c.expect} | ${SHOWN.map((id) => result[id]).join(" | ")} | ${proved ? "yes" : "NO"} |`,
  );
  if (c.rule)
    rows.push(
      `|  | ${report.rules.find((r) => r.id === c.rule).reason.replaceAll("|", "\\|")} |${" |".repeat(SHOWN.length + 1)}`,
    );
}

const md = [
  "# Verifier proof against the stand-in",
  "",
  `- verifier: \`${commit}\``,
  `- fake Slack: \`${envCommit}\` (environments/slack-app/fake-slack)`,
  `- product: the stand-in in standin/`,
  "",
  `| Case | Expected | ${SHOWN.join(" | ")} | Proved |`,
  `|---|---|${SHOWN.map(() => "---|").join("")}---|`,
  ...rows,
  "",
].join("\n");
writeFileSync(join(out, "summary.md"), md);
process.stdout.write(md);
process.exit(ok ? 0 : 1);
