#!/usr/bin/env node
// Scores a committed Rome on rules 1 to 8 of the ambient agent goal, rule set
// V4 (~/.rome-environments/ambient-agent/rules-V4.md), in the slack-app
// environment. How each rule is checked: README.md.
//
// Usage: node verify.mjs --env <env.json> [--rules 1,2,...] [--runs 3] [--bursts]
//   [--instance <name>] [--out <dir>] [--reply-seconds <n>] [--after-reply-seconds <n>]
//   [--settle-seconds <n>] [--work-seconds <n>] [--side-delay-seconds <n>]
//   [--thread-rounds <n>] [--pace-margin-ms <n>] [--test-prefix "<argv>"] [--dirty]
// Exits 0 when every scored rule passes, 1 when one fails, 3 when the agent
// does not answer at all or the environment is not usable, 2 on bad usage.

import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { lastJson, run } from "./lib/control.mjs";
import { loadEnv } from "./lib/env.mjs";
import { pace } from "./lib/pace.mjs";
import { markdown } from "./lib/report.mjs";
import { fakeSlack } from "./lib/slack.mjs";
import { rightPerson } from "./rules/person.mjs";
import { burstSizes, rightPlace } from "./rules/place.mjs";
import { directMessages } from "./rules/private.mjs";
import { recall, replyAfter, stopped } from "./rules/recall.mjs";
import { silence } from "./rules/silence.mjs";
import { structure } from "./rules/structure.mjs";
import { workReturns } from "./rules/work.mjs";

const RULES_VERSION = "V4";
const RULES = {
  1: { title: "Recall in Slack", check: recall, live: true },
  2: { title: "Silence", check: silence, live: true },
  3: { title: "Instance stopped", check: stopped, live: true },
  4: { title: "No platform-specific logic", check: structure, live: false },
  5: { title: "Right place", check: rightPlace, live: true },
  6: { title: "Right person", check: rightPerson, live: true },
  7: { title: "Direct messages stay private", check: directMessages, live: true },
  8: { title: "Work that returns", check: workReturns, live: true },
};
// Silence runs first, so no late reply from another rule lands in its count.
const ORDER = [2, 1, 3, 5, 6, 7, 8, 4];

const here = fileURLToPath(new URL(".", import.meta.url));
const { values: opt } = parseArgs({
  options: {
    env: { type: "string" },
    rules: { type: "string", default: "1,2,3,4,5,6,7,8" },
    runs: { type: "string", default: "3" },
    bursts: { type: "boolean", default: false },
    instance: { type: "string" },
    out: { type: "string" },
    "reply-seconds": { type: "string", default: "180" },
    "settle-seconds": { type: "string" },
    "work-seconds": { type: "string", default: "900" },
    "side-delay-seconds": { type: "string", default: "5" },
    "thread-rounds": { type: "string", default: "1" },
    "pace-margin-ms": { type: "string", default: "2000" },
    "after-reply-seconds": { type: "string", default: "5" },
    "test-prefix": { type: "string" },
    dirty: { type: "boolean", default: false },
  },
});
if (!opt.env) {
  process.stderr.write(
    "usage: verify.mjs --env <env.json> [--rules 1,2,...] [--runs 3] [--bursts] [--dirty]\n",
  );
  process.exit(2);
}
const wanted = opt.rules.split(",").map((s) => Number(s.trim()));
if (wanted.some((n) => !RULES[n])) {
  process.stderr.write(`--rules takes rule numbers 1 to 8, got ${opt.rules}\n`);
  process.exit(2);
}

// A report names the verifier commit, so the code that ran must be that commit.
const gitHere = (...args) =>
  execFileSync("git", ["-C", here, ...args])
    .toString()
    .trim();
const dirty = gitHere("status", "--porcelain", "--", ".");
if (dirty && !opt.dirty) {
  process.stderr.write(
    `refusing to run: verifiers/ambient-agent has uncommitted changes:\n${dirty}\n`,
  );
  process.exit(2);
}
const verifierCommit = `${gitHere("rev-parse", "HEAD")}${dirty ? "+uncommitted" : ""}`;

const env = loadEnv(opt.env, opt.instance);
const startedAt = new Date();
const stamp = startedAt
  .toISOString()
  .replace(/[-:]/g, "")
  .replace(/\.\d+Z$/, "Z");
const outDir =
  opt.out ??
  join(
    homedir(),
    ".rome-environments/ambient-agent/runs",
    `${stamp}-${env.commits.product.slice(0, 12)}`,
  );
mkdirSync(outDir, { recursive: true });

const log = (line) => process.stdout.write(`${line}\n`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const slack = fakeSlack(env.control);

const report = {
  rulesVersion: RULES_VERSION,
  commits: {
    product: env.commits.product,
    productRef: env.commits.productRef,
    verifier: verifierCommit,
    environment: env.commits.environment,
  },
  model: env.model,
  effort: env.effort,
  runsPerRule: Number(opt.runs),
  env: env.path,
  instance: env.instance.name,
  workspace: env.workspace.id,
  historyLimit: env.historyLimit,
  startedAt: startedAt.toISOString(),
  liveness: null,
  rules: {},
};

/** The workspace as the checks address it, read from the fake Slack's state. */
function workspaceOf(ws, guardian) {
  const people = ws.members
    .filter((m) => !m.is_restricted && !m.is_bot && !m.deleted && m.id !== guardian)
    .map((m) => m.id);
  const chats = ws.groups
    .filter((g) => g.bot_member !== false)
    .map((g) => ({
      id: g.id,
      name: g.name,
      members: g.members,
      people: people.filter((p) => g.members.includes(p)),
    }));
  const dms = Object.fromEntries(
    ws.members.filter((m) => m.im_channel).map((m) => [m.id, m.im_channel]),
  );
  return {
    people,
    chats: chats.filter((c) => c.people.length > 0),
    general: chats.find((c) => c.name === "general"),
    dms,
    dmPeople: people.filter((p) => dms[p]),
    scopes: ws.scopes ?? [],
  };
}

async function main() {
  const live = wanted.some((n) => RULES[n].live);
  let ctx = {
    env,
    slack,
    log,
    sleep,
    usedTopics: [],
    runs: Number(opt.runs),
    testPrefix: opt["test-prefix"]?.split(" ").filter(Boolean) ?? [],
  };
  if (live) {
    if (!env.historyLimit.on)
      return fault("env.json says Slack's history limit is off; every check needs it on");
    const state = await slack.state();
    const ws = state.workspaces.find((w) => w.id === env.workspace.id);
    if (!ws?.installed)
      return fault(
        `the app is not installed in workspace ${env.workspace.id}, so no mention can reach the instance`,
      );
    const guardian = env.workspace.guardian ?? ws.members.find((m) => m.is_owner)?.id;
    const w = workspaceOf(ws, guardian);
    if (!w.general) return fault(`workspace ${env.workspace.id} has no #general the app is in`);
    if (!w.general.members.includes(guardian))
      return fault(`the guardian of ${ws.id} is not in #general`);
    // Persons A and B are members who are not the guardian.
    if (w.general.people.length < 2)
      return fault(
        `#general has ${w.general.people.length} member(s) besides the guardian; the checks need two`,
      );
    ctx = {
      ...ctx,
      ...w,
      team: ws.id,
      channel: w.general.id,
      members: w.general.members.filter((m) => m === guardian || w.people.includes(m)),
      people: w.general.people,
      guardian,
      replyMs: Number(opt["reply-seconds"]) * 1000,
      afterReplyMs: Number(opt["after-reply-seconds"]) * 1000,
      workMs: Number(opt["work-seconds"]) * 1000,
      sideDelayMs: Number(opt["side-delay-seconds"]) * 1000,
      restartMs: 300_000,
      messageGapMs: 150,
      paceMarginMs: Number(opt["pace-margin-ms"]),
      threadRounds: Number(opt["thread-rounds"]),
      paceSince: await slack.seq(),
    };
    report.workspaceShape = {
      chats: w.chats.map((c) => ({ id: c.id, name: c.name, people: c.people.length })),
      people: w.people.length,
      dmPeople: w.dmPeople.length,
    };
    log(`liveness: one mention from the guardian in #general of ${ws.id}`);
    // The first pace looks at every read the app made, not only this run's.
    ctx.paceSince = undefined;
    await pace(ctx);
    ctx.paceSince = await slack.seq();
    const since = ctx.paceSince;
    const asked = await slack.mention(
      ctx.team,
      guardian,
      ctx.channel,
      "hello, are you there? Just say hi.",
    );
    const t0 = Date.now();
    const posts = await replyAfter(ctx, since);
    report.liveness = {
      mentionTs: asked.ts,
      eventSent: asked.eventSent,
      delivery: asked.status,
      replies: posts.map((p) => ({ ts: p.ts, text: p.text })),
      seconds: Math.round((Date.now() - t0) / 1000),
    };
    if (!posts.length) {
      return fault(
        `agent not answering: the guardian's mention in #general got no reply in ${opt["reply-seconds"]} s (event sent: ${asked.eventSent}, delivery status: ${asked.status}). This is an environment or product fault, not a rule failure`,
      );
    }
    // Long enough for a reply to a message to have arrived: twice the
    // liveness reply's time, and at least a minute.
    ctx.settleMs = opt["settle-seconds"]
      ? Number(opt["settle-seconds"]) * 1000
      : Math.max(60_000, 2 * (Date.now() - t0));
    log(`  replied in ${report.liveness.seconds} s`);
  }
  for (const n of ORDER) {
    if (!wanted.includes(n)) {
      report.rules[n] = {
        title: RULES[n].title,
        result: "not checked",
        reason: "not asked for (--rules)",
      };
      continue;
    }
    log(`rule ${n}: ${RULES[n].title}`);
    const t0 = Date.now();
    let r;
    try {
      r = await RULES[n].check(ctx);
    } catch (error) {
      r = { result: "not checked", reason: `the check failed: ${error.message}` };
    }
    report.rules[n] = {
      title: RULES[n].title,
      ...r,
      seconds: Math.round((Date.now() - t0) / 1000),
    };
    log(`  ${r.result}: ${r.reason}`);
  }
  if (opt.bursts && live) {
    log("bursts (not scored): 1, 3, 10 and 30 mentions at once");
    const t0 = Date.now();
    try {
      report.bursts = { ...(await burstSizes(ctx)), seconds: Math.round((Date.now() - t0) / 1000) };
    } catch (error) {
      report.bursts = { reason: `the check failed: ${error.message}` };
    }
  }
  return finish();
}

function fault(reason) {
  report.fault = reason;
  for (const n of ORDER) report.rules[n] = { title: RULES[n].title, result: "not checked", reason };
  log(reason);
  return finish(3);
}

async function finish(code) {
  const ended = new Date();
  report.endedAt = ended.toISOString();
  report.seconds = Math.round((ended - startedAt) / 1000);
  if (env.instance.logs) {
    const r = await run(env.instance.logs, ["--since", report.startedAt], { timeoutMs: 120_000 });
    const file = `logs-${env.instance.name}.log`;
    writeFileSync(
      join(outDir, file),
      r.stdout + (r.code ? `\n[logs control exited ${r.code}] ${r.stderr}` : ""),
    );
    report.logs = file;
  }
  if (env.cost) {
    const r = await run(env.cost, ["--since", report.startedAt, "--until", report.endedAt], {
      timeoutMs: 60_000,
    });
    report.cost = lastJson(r.stdout) ?? {
      error: `usage control exited ${r.code}: ${(r.stderr || r.stdout).trim().slice(-300)}`,
    };
  } else report.cost = null;
  const asked = wanted.map((n) => report.rules[n]);
  report.result =
    code === 3
      ? "fault"
      : asked.some((r) => r.result === "fail")
        ? "fail"
        : asked.every((r) => r.result === "pass")
          ? "pass"
          : "incomplete";
  writeFileSync(join(outDir, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  writeFileSync(join(outDir, "report.md"), markdown(report));
  log(`report: ${outDir}`);
  return { pass: 0, fail: 1 }[report.result] ?? 3;
}

main().then(
  (code) => process.exit(code),
  (error) => {
    process.stderr.write(`${error.stack ?? error}\n`);
    process.exit(3);
  },
);
