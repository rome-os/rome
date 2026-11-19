// Proves the verifier before the product exists: runs it against the good
// stand-in, where every phase 1 rule must pass, and against each broken
// stand-in, where the rule it breaks must fail (or, where the case says,
// report "not checked" or still pass).
//
// Usage: node prove.mjs [git ref of the environment, default
// origin/slack-official-app/environment]. Writes out/proof/summary.md.

import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const here = fileURLToPath(new URL(".", import.meta.url));
const ref = process.argv[2] ?? "origin/slack-official-app/environment";
const out = join(here, "out/proof");
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

const PHASE1 = ["R1", "R3", "R4", "R6", "R7", "R11"];
const CASES = [
  { name: "good", breaks: "", expect: "every phase 1 rule passes" },
  {
    name: "R1-fields",
    breaks: "R1-fields",
    rule: "R1",
    what: "setup asks for a bot token and a signing secret",
  },
  {
    name: "R1-twice",
    breaks: "R1-twice",
    rule: "R1",
    what: "Connect sends the guardian through the Slack sign-in twice",
  },
  { name: "R1-agent", breaks: "R1-agent", rule: "R1", what: "the connected account gets no agent" },
  {
    name: "R3",
    breaks: "R3",
    rule: "R3",
    what: "Rome Cloud lets a second instance take a bound workspace",
  },
  { name: "R4", breaks: "R4", rule: "R4", what: "the instance replies twice to each message" },
  {
    name: "R4-elsewhere",
    breaks: "R4-elsewhere",
    rule: "R4",
    what: "each reply is also posted in another member's direct message",
  },
  {
    name: "R6",
    breaks: "R6",
    rule: "R6",
    what: "the instance throws away its mailbox when it starts",
  },
  {
    name: "R7-signature",
    breaks: "R7-signature",
    rule: "R7",
    what: "Rome Cloud skips Slack's signature check",
  },
  {
    name: "R7-route",
    breaks: "R7-route",
    rule: "R7",
    what: "Rome Cloud delivers every event to every bound instance",
  },
  { name: "R11", breaks: "R11", rule: "R11", what: "the relay gains a Slack file" },
  {
    name: "R7-quiet",
    breaks: "R7-signature,R7-quiet",
    rule: "R7",
    what: "forged events get through and are answered with no code",
  },
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
  {
    name: "R7-gateway",
    breaks: "R7-gateway",
    rule: "R7",
    result: "not checked",
    what: "a gateway answers 502 to every forged event",
  },
  {
    name: "R7-blind",
    breaks: "R7-route,R7-blind",
    rule: "R7",
    what: "the wrong instance answers workspace A's events in its own workspace, naming nothing of A",
  },
  {
    name: "R6-stop-error",
    breaks: "R6-stop-error",
    rule: "R6",
    result: "pass",
    what: "the stop control stops the instance, then reports a failure",
  },
  {
    name: "R7-lookup",
    breaks: "R7-route,R7-lookup",
    rule: "R7",
    what: "the wrong instance looks up workspace A's sender, then drops the event",
  },
  {
    name: "R11-eof",
    breaks: "R11-eof",
    rule: "R11",
    what: "a CREATE TABLE with no semicolon at the end of the file stores the bot token",
  },
  {
    name: "R11-migration",
    breaks: "R11-migration",
    rule: "R11",
    what: "a migration adds a bot token column",
  },
  {
    name: "R11-sql",
    breaks: "R11-sql",
    rule: "R11",
    what: "a one-line CREATE TABLE stores the bot token",
  },
  { name: "R11-store", breaks: "R11-store", rule: "R11", what: "Rome Cloud stores the bot token" },
];

const rows = [];
let ok = true;
for (const c of CASES) {
  const work = join(out, c.name);
  const world = spawn(
    process.execPath,
    [join(here, "standin/up.mjs"), join(out, "fake-slack"), work],
    {
      stdio: ["ignore", "inherit", "inherit"],
      env: { ...process.env, BREAK: c.breaks },
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
    }).on("exit", r);
  });
  world.kill("SIGTERM");
  await new Promise((r) => world.on("exit", r));

  const report = JSON.parse(readFileSync(join(work, "report/report.json"), "utf8"));
  const result = Object.fromEntries(report.rules.map((r) => [r.id, r.result]));
  const proved = c.rule
    ? result[c.rule] === (c.result ?? "fail")
    : PHASE1.every((id) => result[id] === "pass");
  ok &&= proved;
  rows.push(
    `| ${c.name} | ${c.rule ? `${c.rule} ${c.result ?? "fail"}: ${c.what}` : c.expect} | ${PHASE1.map((id) => result[id]).join(" | ")} | ${proved ? "yes" : "NO"} |`,
  );
  if (c.rule)
    rows.push(
      `|  | ${report.rules.find((r) => r.id === c.rule).reason.replaceAll("|", "\\|")} | | | | | | | |`,
    );
}

const md = [
  "# Verifier proof against the stand-in",
  "",
  `- verifier: \`${commit}\``,
  `- fake Slack: \`${envCommit}\` (environments/slack-app/fake-slack)`,
  `- product: the stand-in in standin/`,
  "",
  `| Case | Expected | ${PHASE1.join(" | ")} | Proved |`,
  `|---|---|${PHASE1.map(() => "---|").join("")}---|`,
  ...rows,
  "",
].join("\n");
writeFileSync(join(out, "summary.md"), md);
process.stdout.write(md);
process.exit(ok ? 0 : 1);
