#!/usr/bin/env node
// Scores the official Slack app's three rubric entries against real Slack and
// production. Usage:
//   node verifiers/slack-app-live/run.mjs --env ~/.config/rome/slack-tester.env --out <dir>
//     [--signer-jwt-file <path>] [--rome-cloud https://romeos.cc] [--chromium <path>]
// Writes <out>/report.json and <out>/report.md. Sends at most one message per
// entry, and none when the app is not installed.

import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { loadApprovalPage } from "./lib/approval-page.mjs";
import {
  entryApprovalPage,
  entryDirectMessage,
  entryMention,
  findRomeBot,
} from "./lib/entries.mjs";
import { slackClient } from "./lib/slack.mjs";

const { values: args } = parseArgs({
  options: {
    env: { type: "string" },
    out: { type: "string" },
    "signer-jwt-file": { type: "string" },
    "rome-cloud": { type: "string", default: "https://romeos.cc" },
    chromium: { type: "string", default: process.env.CHROMIUM_PATH },
  },
});
if (!args.env || !args.out) {
  console.error("usage: run.mjs --env <slack-tester.env> --out <dir> [--signer-jwt-file <path>]");
  process.exit(2);
}

function readEnvFile(path) {
  const env = {};
  for (const raw of readFileSync(path, "utf8").split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    env[line.slice(0, eq)] = line.slice(eq + 1).replace(/^["']|["']$/g, "");
  }
  return env;
}

const env = readEnvFile(args.env);
for (const k of [
  "SLACK_TESTER_USER_TOKEN",
  "SLACK_TESTER_TEAM_ID",
  "SLACK_TESTER_USER_ID",
  "SLACK_TESTER_D_COOKIE",
])
  if (!env[k]) throw new Error(`${k} missing from the env file`);

const slack = slackClient(env.SLACK_TESTER_USER_TOKEN);
const nonce = randomBytes(4).toString("hex");
const startedAt = new Date().toISOString();

// The tester token must be the tester in the tester's workspace, or nothing below means anything.
const who = await slack.call("auth.test");
if (who.team_id !== env.SLACK_TESTER_TEAM_ID || who.user_id !== env.SLACK_TESTER_USER_ID)
  throw new Error("the tester token belongs to another workspace or user than the env file names");

// Rome Cloud answers the install link only to an enrolled instance's signer
// JWT. Without one there is no honest link: the entry says what is missing.
async function installLink() {
  const endpoint = `${args["rome-cloud"]}/api/instance/slack/install-url`;
  if (!args["signer-jwt-file"]) {
    const probe = await fetch(endpoint, { method: "POST" });
    return {
      link: null,
      reason: `no instance signer JWT for ${new URL(endpoint).host}: install-url answers ${probe.status} without one, and only an instance enrolled with Rome Cloud can sign it (pass --signer-jwt-file)`,
    };
  }
  const jwt = readFileSync(args["signer-jwt-file"], "utf8").trim();
  const res = await fetch(endpoint, {
    method: "POST",
    headers: { authorization: `Bearer ${jwt}` },
  });
  if (res.status !== 200)
    return { link: null, reason: `install-url answered ${res.status} to the signer JWT` };
  const { url } = await res.json();
  return { link: url, source: `POST ${new URL(endpoint).host}/api/instance/slack/install-url` };
}

const loadPage = (link) =>
  loadApprovalPage(link, { dCookie: env.SLACK_TESTER_D_COOKIE, executablePath: args.chromium });

const { bot, scanned } = await findRomeBot(slack);
const entries = [
  await entryApprovalPage({ installLink, loadPage }),
  await entryDirectMessage({ slack, bot, nonce }),
  await entryMention({ slack, bot, nonce }),
];

const report = {
  started_at: startedAt,
  finished_at: new Date().toISOString(),
  workspace: "SLACK_TESTER_TEAM_ID",
  nonce,
  bot: bot ? { found: true, user: bot.id } : { found: false, users_scanned: scanned },
  entries,
};
mkdirSync(args.out, { recursive: true });
writeFileSync(join(args.out, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
const md = [
  `# Slack app rubric, live (${startedAt})`,
  "",
  `Rome bot: ${bot ? `found (${bot.id})` : `not installed (${scanned} users scanned)`}`,
  "",
  "| Entry | Verdict | Reason |",
  "|---|---|---|",
  ...entries.map((e) => `| ${e.id} | ${e.verdict} | ${e.reason} |`),
  "",
].join("\n");
writeFileSync(join(args.out, "report.md"), md);
console.log(md);
