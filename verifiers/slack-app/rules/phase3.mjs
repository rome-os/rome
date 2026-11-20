// Phase 3 rules R9 and R10. Rule text: rule set v2 in the planner's rules.md;
// the checks are in briefs/verifier.md, "Phase 3". R2 is in connect.mjs,
// since it is R1's check from another workspace.

import { execFileSync, spawn } from "node:child_process";
import { sleep } from "../lib/http.mjs";
import { replyAfter } from "../lib/replies.mjs";

// The connector app's existing tests for its Slack actions on main: what R9
// runs unchanged on the product commit.
export const CONNECTOR_SLACK_TESTS = [
  "rome_apps/connector/src/api/slack-proxy.test.ts",
  "rome_apps/connector/src/actions/connector-proxy.test.ts",
  "rome_apps/connector/src/actions/connector-tool-execute.test.ts",
  "rome_apps/connector/src/actions/connector-actions.test.ts",
];

// A line that states what a test asserts, or that a test exists.
const ASSERTION = /\bexpect\(|\.(not\.)?to[A-Z]\w*\(|\b(it|test)(\.each)?\(|\bdescribe\(/;

/**
 * R9's test half: the existing tests, unchanged on the product commit, pass
 * there. Returns {ok, reason, evidence}; ok is null when it could not be run.
 */
export async function existingTests(env) {
  const dir = env.repos?.rome;
  const evidence = { files: CONNECTOR_SLACK_TESTS };
  if (!dir) return { ok: null, reason: "the environment names no rome checkout", evidence };
  if (env.repos.romeDependencies && env.repos.romeDependencies !== "installed")
    return {
      ok: null,
      reason: `the rome checkout's dependencies are ${env.repos.romeDependencies}, an environment fault`,
      evidence,
    };
  const git = (...args) => execFileSync("git", ["-C", dir, ...args], { stdio: "pipe" }).toString();
  const head = git("rev-parse", "HEAD").trim();
  evidence.checkout = head;
  if (env.commits?.rome && !head.startsWith(env.commits.rome) && !env.commits.rome.startsWith(head))
    return {
      ok: null,
      reason: `the rome checkout is at ${head.slice(0, 9)}, not the product commit ${env.commits.rome}`,
      evidence,
    };

  // What the product changed in those files since it left the base.
  const base = env.repos.romeBase ?? "origin/main";
  const diff = git("diff", "--unified=0", `${base}...HEAD`, "--", ...CONNECTOR_SLACK_TESTS);
  const removed = diff
    .split("\n")
    .filter((l) => l.startsWith("-") && !l.startsWith("---") && ASSERTION.test(l))
    .map((l) => l.slice(1).trim());
  const deleted = CONNECTOR_SLACK_TESTS.filter((f) => {
    try {
      git("cat-file", "-e", `HEAD:${f}`);
      return false;
    } catch {
      return true;
    }
  });
  evidence.changedAssertions = removed;
  evidence.deletedFiles = deleted;

  // The environment's command, with the files appended, else rstest through
  // packages/core.
  const argv = env.r9?.testCommand
    ? [...env.r9.testCommand, ...(env.r9.appendFiles ? CONNECTOR_SLACK_TESTS : [])]
    : [
        "bash",
        "-c",
        `cd packages/core && ../../scripts/test-env.sh rstest ${CONNECTOR_SLACK_TESTS.map((f) => `../../${f}`).join(" ")}`,
      ];
  const run = await runCommand(argv, dir, 15 * 60_000);
  evidence.run = { argv, exit: run.code, tail: run.output.split("\n").slice(-30) };
  // A runner that could not start ran no test: not checked, never a fail.
  if (run.code === 127 || run.code === 126 || run.code === -1 || /command not found|ENOENT/.test(run.output.slice(-2000)) && !/Tests\s+\d+/.test(run.output))
    return {
      ok: null,
      reason: `the tests did not run (exit ${run.code}: ${run.output.trim().split("\n").at(-1)?.slice(0, 160) ?? ""}), an environment fault`,
      evidence,
    };
  const counts = run.output.match(/Tests\s+(\d+)\s+passed(?:\s*\|\s*(\d+)\s+failed)?/i);
  evidence.run.passed = counts ? Number(counts[1]) : null;
  evidence.run.failed = counts?.[2] ? Number(counts[2]) : run.code === 0 ? 0 : null;
  const failing = [...run.output.matchAll(/^\s*(?:✗|×|FAIL)\s+(.+)$/gm)].map((m) => m[1].trim());
  evidence.run.failing = failing.slice(0, 20);

  const problems = [];
  if (deleted.length) problems.push(`the product deleted ${deleted.join(", ")}`);
  if (removed.length)
    problems.push(`the product changed or removed ${removed.length} assertion(s), first: ${removed[0]}`);
  if (run.code !== 0)
    problems.push(
      `the tests failed (exit ${run.code}${failing.length ? `; ${failing.slice(0, 3).join("; ")}` : ""})`,
    );
  return problems.length
    ? { ok: false, reason: problems.join("; "), evidence }
    : {
        ok: true,
        reason: `the ${CONNECTOR_SLACK_TESTS.length} test files pass unchanged${evidence.run.passed !== null ? ` (${evidence.run.passed} tests)` : ""}`,
        evidence,
      };
}

function runCommand(argv, cwd, timeoutMs) {
  return new Promise((resolve) => {
    const child = spawn(argv[0], argv.slice(1), { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout.on("data", (d) => (output += d));
    child.stderr.on("data", (d) => (output += d));
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ code: -1, output: `${output}\n${err.message}` });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, output });
    });
  });
}

// R9's live check ---------------------------------------------------------
//
// Provisional reading, until Ouou rules: through the new connection an agent
// can send, read and search, and nothing else. Scored through the agent: the
// guardian asks the Concierge in plain words, and the check judges by what
// the fake Slack recorded and where posts landed. Only read and search are
// judged by the reply, for the seeded value. Each operation is asked up to 3
// times in different words, so a model miss reads as "not checked", not a fail.

const mark = (s) => new RegExp(s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
const holds = (text, m) => mark(m).test(text ?? "");

// Asks name a group with its id, since the connection offers no listing to
// find one by name. One unscored ask names #news alone (`byName`).
const SENDS = [
  { sentence: "The garden party moves to the Wintercombe lawn.", mark: "Wintercombe" },
  { sentence: "Fresh pears are waiting in the Fennimore orchard.", mark: "Fennimore" },
  { sentence: "The rowing boats are back at the Saltcote boathouse.", mark: "Saltcote" },
];
const SEND_ASKS = [
  (s, g) => `Please post this exact sentence in the #general channel (${g.general}): "${s}"`,
  (s, g) => `Could you send a message to #general (channel ${g.general}) on Slack saying: ${s}`,
  (s, g) => `Post to the general group on Slack, ${g.general}, word for word: ${s}`,
];
const BY_NAME = {
  sentence: "The library book sale is on at the Coldharbour hall.",
  mark: "Coldharbour",
  ask: (s) => `Please post this exact sentence in the #news channel: "${s}"`,
};

// Each read seeds one message in #news just before it is asked.
const READS = [
  { text: "The bakery van now parks by the Quenby fountain.", mark: "Quenby" },
  { text: "Ivy has hung the Larchmere tapestry in the lobby.", mark: "Larchmere" },
  { text: "The ferry timetable now lists Tolverne Quay.", mark: "Tolverne" },
];
const READ_ASKS = [
  (g) => `What were the last few messages in the #news channel (${g.news}) on Slack?`,
  (g) => `Can you read the latest messages in #news (channel ${g.news}) and tell me what they say?`,
  (g) => `Look at the news group on Slack, ${g.news}: what has been said there most recently?`,
];

// Each search seeds a mention of the app in #news, which Rome keeps, and the
// same word as a plain message in #quiet, which the app is not in. A #quiet
// value must never appear in any post.
const SEARCHES = [
  {
    word: "tangerine",
    found: { text: "The tangerine stall opens at the Wrenfield market.", mark: "Wrenfield" },
    outside: { text: "The tangerine crates went to the Gorsemoor depot.", mark: "Gorsemoor" },
  },
  {
    word: "rowing club",
    found: { text: "The rowing club picnic will be at Hollyfold Meadow.", mark: "Hollyfold" },
    outside: { text: "The rowing club dinner moved to Pellingham Hall.", mark: "Pellingham" },
  },
  {
    word: "choir",
    found: { text: "The choir sings its spring concert in Bramscott Chapel.", mark: "Bramscott" },
    outside: { text: "The choir tickets are with Ottilie Varnworth.", mark: "Varnworth" },
  },
];
const SEARCH_ASKS = [
  (w) => `Search Slack for the message that mentions "${w}" and tell me what it said.`,
  (w) => `Can you find the Slack message about the ${w} and tell me what it says?`,
  (w) => `Look up "${w}" in Slack and tell me what you find.`,
];

// After Rome's copy of #news is wiped, a search that names #news must still
// find this; one that names no chat is only observed.
const WIPED = {
  word: "lantern parade",
  found: { text: "The lantern parade starts at Ebbridge Green.", mark: "Ebbridge" },
};
const NAMED_SEARCH_ASKS = [
  (w, g) => `Search #news (${g.news}) for the message that mentions "${w}" and tell me what it said.`,
  (w, g) => `In the #news channel, ${g.news}, find the message about the ${w} and tell me what it says.`,
  (w, g) => `Look up "${w}" in #news (channel ${g.news}) and tell me what you find.`,
];

// Reads scored on the guardian's direct message, which the app as built may
// read: the app hears each value there, and the guardian asks for it on the
// dashboard. One more is asked after Rome's copy of the chat is wiped.
const DM_READS = [
  { text: "Note to self: the spare umbrella is in the Harrowgate cupboard.", thing: "the spare umbrella", mark: "Harrowgate" },
  { text: "Note to self: the bicycle pump is in the Ashcombe shed.", thing: "the bicycle pump", mark: "Ashcombe" },
  { text: "Note to self: the good scissors are in the Whitlow drawer.", thing: "the good scissors", mark: "Whitlow" },
];
const DM_READ_ASKS = [
  (t, dm) => `Please read the recent messages in this direct message on Slack (${dm}) and tell me where I said ${t} is.`,
  (t, dm) => `Look back through our Slack direct message ${dm}: where did I say ${t} is?`,
  (t, dm) => `Check the history of this Slack conversation (${dm}) and tell me where ${t} is, as I wrote it.`,
];

// The read after a wipe of Rome's copy of the direct message.
const DM_WIPED_READ = {
  text: "Note to self: the winter blankets are in the Thornaby chest.",
  thing: "the winter blankets",
  mark: "Thornaby",
};

// The search after a wipe, scored on the direct message: Rome heard the
// value there, then its copy of the chat is wiped.
const DM_WIPED = {
  word: "the picnic hamper",
  text: "Just so you know, the picnic hamper is at the Mossbridge cottage.",
  found: { mark: "Mossbridge" },
};
const DM_SEARCH_ASKS = [
  (w, dm) => `Search this direct message (${dm}) for the message about ${w} and tell me what it said.`,
  (w, dm) => `In our Slack direct message ${dm}, find the message about ${w} and tell me what it says.`,
  (w, dm) => `Look up ${w} in this Slack conversation (${dm}) and tell me what you find.`,
];

// With --r9-groups only: listing the app's groups, and a refused read in a
// group it is not in.
const LIST_ASKS = [
  () => "Which Slack channels are you a member of? Please list them by name.",
  () => "List the Slack groups you are in, please.",
  () => "What Slack channels can you see as a member? Give me their names.",
];
const QUIET_ASK = (g) => `What were the last few messages in the #quiet channel (${g.quiet}) on Slack?`;
const QUIET_MARKS = ["marmalade"];

// The method that must be refused: a reaction.
const REFUSALS = [
  (g) => `Please add a thumbs-up reaction to the last message you posted in #general (${g.general}).`,
  (g) => `React with a party emoji to the newest message in the #news channel (${g.news}).`,
];

/** One line on the unscored group checks: each worked, or refused with Slack's error. */
function groupSummary(observations) {
  return Object.entries(observations)
    .filter(([, o]) => o && typeof o === "object" && "worked" in o)
    .map(([op, o]) => `${op} ${o.worked ? "worked" : `refused${o.errors.length ? ` (${o.errors.join(", ")})` : ""}`}`)
    .join("; ");
}

/**
 * Asks the Concierge as the guardian in the dashboard's own chat on `inst`
 * (in a Slack direct message its actions are withheld), and returns its reply
 * there with the fake's seq read just before. Slack is where results are judged.
 *
 * The Concierge may answer "On it" and post a task's result later, so the
 * chat is read again for up to answerSeconds: until `right(asked)` holds
 * when given, else until something follows the first reply.
 */
async function askConcierge(ctx, inst, text, { right } = {}) {
  const since = await ctx.slack.seq();
  const asked = await inst.askDashboard(text, {
    timeoutMs: ctx.env.timeouts.replySeconds * 3000,
    settleMs: ctx.env.timeouts.settleSeconds * 1000,
  });
  const out = { since, at: asked.at, channel: null, reply: asked.reply ?? "", error: asked.error ?? null };
  const first = out.reply;
  const deadline = asked.at + ctx.env.timeouts.answerSeconds * 1000;
  out.right = right ? await right(out) : false;
  while (!asked.error && !out.right && Date.now() < deadline) {
    if (!right && out.reply !== first) {
      // Something followed the first reply; let it settle.
      await sleep(ctx.env.timeouts.settleSeconds * 1000);
      out.reply = await asked.refresh();
      break;
    }
    await sleep(Math.min(5000, Math.max(0, deadline - Date.now())));
    out.reply = await asked.refresh();
    if (right) out.right = await right(out);
  }
  out.waitedSeconds = Math.round((Date.now() - asked.at) / 1000);
  // R9 scans every dashboard reply for #quiet values, as it scans Slack posts.
  ctx.dashboardReplies?.push({ asked: text, reply: out.reply });
  ctx.r9Timeline?.push({
    at: new Date(asked.at).toISOString(),
    step: "ask",
    text,
    waitedSeconds: out.waitedSeconds,
    right: right ? out.right : undefined,
    reply: out.reply.slice(0, 200),
  });
  return out;
}

/** A direct message the app hears from the guardian, once its Slack reply came. */
async function heardDm(ctx, ws, text) {
  const before = await ctx.slack.seq();
  const at = new Date().toISOString();
  const sent = await ctx.slack.dm(ws.id, ws.guardian, text);
  const replied = await replyAfter(ctx.slack, {
    team: ws.id,
    channel: sent.channel,
    since: before,
    timeoutMs: ctx.env.timeouts.replySeconds * 1000,
  });
  ctx.r9Timeline?.push({ at, step: "seed direct message", text, control: sent, replied, repliedBy: replied ? new Date().toISOString() : null });
  await sleep(ctx.env.timeouts.settleSeconds * 1000);
}

/** Executions after `at` that touch Slack, by name or by what they were given. */
function slackExecutions(groups, ids) {
  const touches = (x) =>
    /slack/i.test(x?.actionName ?? "") ||
    ids.some((id) => JSON.stringify(x?.args ?? "").includes(id)) ||
    /slack/i.test(JSON.stringify(x?.args ?? ""));
  return (groups ?? [])
    .flatMap((g) => [g.rootExecution, ...(g.children ?? [])])
    .filter(touches)
    .map((x) => {
      // Everything the listing gives beyond name and status.
      const { actionName, status, error, ...rest } = x ?? {};
      const input = x?.args ?? x?.input ?? x?.params;
      return {
        action: actionName,
        status,
        error: error ?? null,
        input: input === undefined ? "(the action listing gives no input)" : input,
        ...rest,
      };
    });
}

/**
 * A search's coverage statement, from an execution's result when the
 * instance's listing carries one: the text, false when a result has none,
 * or null when no result is listed.
 */
function coverageOf(groups) {
  const results = (groups ?? [])
    .flatMap((g) => [g.rootExecution, ...(g.children ?? [])])
    .filter((x) => /search/i.test(JSON.stringify(x?.args ?? "")))
    .map((x) => x.result ?? x.output ?? null)
    .filter((r) => r !== null && r !== undefined);
  if (!results.length) return null;
  const said = results.map((r) => JSON.stringify(r).match(/"coverage"\s*:\s*"([^"]+)"/)?.[1]).find(Boolean);
  return said ?? false;
}

/**
 * Asks one operation up to 3 times. `judge(asked)` says whether it went
 * right. Returns {result: pass|fail|not checked, asks, why}.
 */
async function operate(ctx, ws, { asks, judge, methods, ids, inst = ctx.a }) {
  const tries = [];
  for (const text of asks) {
    const asked = await askConcierge(ctx, inst, text, { right: judge });
    const right = asked.right;
    // The Concierge's own reply in the direct message is not an attempt.
    const calls = (await ctx.slack.calls({ team: ws.id, since: asked.since })).filter(
      (c) =>
        (!methods || methods.includes(c.method)) &&
        !(c.method === "chat.postMessage" && c.args?.channel === asked.channel),
    );
    const execs = slackExecutions(await inst.executions(asked.at), ids);
    tries.push({
      asked: text,
      right,
      coverage: coverageOf(await inst.executions(asked.at)),
      ...(asked.error ? { error: asked.error } : {}),
      reply: asked.reply.slice(0, 300),
      waitedSeconds: asked.waitedSeconds,
      calls: calls.map((c) => ({ method: c.method, ok: c.ok, error: c.error ?? null, tokenKind: c.tokenKind })),
      executions: execs,
    });
    if (right) return { result: "pass", tries, why: `right on ask ${tries.length}` };
  }
  const attempted = tries.some((t) => t.calls.length || t.executions.length);
  const errors = tries.flatMap((t) => [
    ...t.calls.filter((c) => !c.ok).map((c) => `${c.method} ${c.error}`),
    ...t.executions.filter((x) => x.status === "error").map((x) => `${x.action}: ${x.error}`),
  ]);
  return attempted
    ? {
        result: "fail",
        tries,
        why: `tried, wrong all 3 times${errors.length ? ` (${[...new Set(errors)].slice(0, 2).join("; ")})` : ""}`,
      }
    : { result: "not checked", tries, why: "the Concierge never attempted it in 3 asks" };
}

/** R9's live check on the first instance's connection to workspace A. */
export async function liveCheck(ctx) {
  const ws = ctx.wsA;
  const state = await ctx.slack.state();
  const w = state.workspaces.find((x) => x.id === ws.id);
  const group = (name) => w?.groups?.find((g) => g.name === name)?.id;
  const general = group("general");
  const news = group("news");
  const quiet = group("quiet");
  if (!general || !news || !quiet)
    return { ok: null, reason: "the fake has no #general, #news and #quiet in workspace A" };
  const inQuiet = w.groups.find((g) => g.id === quiet).members.find((m) => m !== ws.guardian);
  const inNews = w.groups.find((g) => g.id === news).members.find((m) => m !== ws.guardian);
  const startSeq = await ctx.slack.seq();
  const evidence = { groups: { general, news, quiet } };
  // The history limit is R13's to score; here it would only slow the agent.
  const limitWas = state.history_limit?.on ?? true;
  await ctx.slack.config({ history_limit: false });
  const ops = [];
  const observations = {};
  ctx.dashboardReplies = [];
  ctx.r9Timeline = [];
  const scoreGroups = ctx.env.r9?.groups === true;
  try {
    const g = { general, news, quiet };
    // A group check: scored with --r9-groups, else asked once and reported
    // as worked or refused, with Slack's errors.
    const groupCheck = async (op, opts) => {
      if (scoreGroups) return ops.push({ op, ...(await operate(ctx, ws, opts)) });
      const once = await operate(ctx, ws, { ...opts, asks: opts.asks.slice(0, 1) });
      const errors = (once.tries ?? []).flatMap((t) => (t.calls ?? []).filter((c) => !c.ok).map((c) => `${c.method}: ${c.error}`));
      observations[op] = {
        worked: once.result === "pass",
        errors: [...new Set(errors)],
        reply: once.tries?.[0]?.reply ?? null,
      };
    };
    for (const [i, s] of SENDS.entries())
      ops.push({
        op: `send ${i + 1}`,
        ...(await operate(ctx, ws, {
          asks: SEND_ASKS.map((f) => f(s.sentence, g)),
          methods: ["chat.postMessage"],
          ids: [general],
          judge: async (a) =>
            (await ctx.slack.posts({ team: ws.id, channel: general, since: a.since })).some(
              (p) => holds(p.text, s.mark) && p.tokenKind === "bot",
            ),
        })),
      });
    await groupCheck("send to #news by name alone", {
      asks: [BY_NAME.ask(BY_NAME.sentence), BY_NAME.ask(BY_NAME.sentence), BY_NAME.ask(BY_NAME.sentence)],
      methods: ["chat.postMessage"],
      ids: [news],
      judge: async (a) =>
        (await ctx.slack.posts({ team: ws.id, channel: news, since: a.since })).some((p) => holds(p.text, BY_NAME.mark)),
    });
    const dm = w.members?.find((m) => m.id === ws.guardian)?.im_channel;
    // Reads of the direct message: values the app heard there, asked for on
    // the dashboard, with Rome's copy in place.
    for (const r of DM_READS) await heardDm(ctx, ws, r.text);
    for (const [i, r] of DM_READS.entries())
      ops.push({
        op: `read ${i + 1} (direct message)`,
        ...(await operate(ctx, ws, {
          asks: DM_READ_ASKS.map((f) => f(r.thing, dm)),
          methods: ["conversations.history", "conversations.replies"],
          ids: [dm],
          judge: async (a) => holds(a.reply, r.mark),
        })),
      });
    for (const [i, r] of READS.entries()) {
      const at = new Date().toISOString();
      ctx.r9Timeline.push({ at, step: "seed message in #news", text: r.text, control: await ctx.slack.groupMessage(ws.id, inNews, r.text, news) });
      await groupCheck(`read ${i + 1} (#news)`, {
        asks: READ_ASKS.map((f) => f(g)),
        methods: ["conversations.history", "conversations.replies", "conversations.list", "conversations.info"],
        ids: [news],
        judge: async (a) => holds(a.reply, r.mark),
      });
    }
    // A search: the seeds go in first, and the app's own thread reply to
    // the mention settles before the question.
    const seed = async (q) => {
      const before = await ctx.slack.seq();
      const at = new Date().toISOString();
      const mention = await ctx.slack.mention(ws.id, inNews, q.found.text, news);
      const outside = q.outside ? await ctx.slack.groupMessage(ws.id, inQuiet, q.outside.text, quiet) : null;
      const replied = await replyAfter(ctx.slack, {
        team: ws.id,
        channel: news,
        since: before,
        timeoutMs: ctx.env.timeouts.replySeconds * 1000,
      });
      const repliedBy = replied ? new Date().toISOString() : null;
      const replies = (await ctx.slack.posts({ team: ws.id, channel: news, since: before })).map((p) => ({
        seq: p.seq,
        ts: p.ts ?? null,
        thread_ts: p.thread_ts ?? p.threadTs ?? null,
        underMention: (p.thread_ts ?? p.threadTs) === mention.ts,
        text: p.text?.slice(0, 120),
      }));
      ctx.r9Timeline.push({ at, step: "seed mention in #news", text: q.found.text, control: mention, outside, replied, repliedBy, replies });
      await sleep(ctx.env.timeouts.settleSeconds * 1000);
    };
    const searchOpts = (q, asks) => ({ asks, methods: null, ids: [news, quiet, dm], judge: async (a) => holds(a.reply, q.found.mark) });
    for (const [i, q] of SEARCHES.entries()) {
      await seed(q);
      ops.push({ op: `search ${i + 1}`, ...(await operate(ctx, ws, searchOpts(q, SEARCH_ASKS.map((f) => f(q.word))))) });
    }
    // Searches after a wipe: scored on the direct message; in #news only
    // with --r9-groups.
    const wipe = async (conversation, texts) => {
      const at = new Date().toISOString();
      let r;
      try {
        r = await ctx.a.wipeChat(conversation, { texts });
      } catch (err) {
        r = { ok: false, error: err.message };
      }
      ctx.r9Timeline.push({ at, step: "wipe", conversation, done: new Date().toISOString(), ok: r?.ok !== false });
      return r;
    };
    const afterWipe = ["read after wipe (direct message)", "search after wipe (direct message)"];
    if (!ctx.a.canWipe()) {
      for (const op of afterWipe) ops.push({ op, result: "not checked", why: "the environment cannot wipe a chat", tries: [] });
    } else {
      await heardDm(ctx, ws, DM_WIPED_READ.text);
      await heardDm(ctx, ws, DM_WIPED.text);
      const wipedDm = await wipe(dm, [DM_WIPED_READ.text, DM_WIPED_READ.mark, DM_WIPED.text, DM_WIPED.found.mark]);
      evidence.wipeDirectMessage = wipedDm;
      if (wipedDm?.ok === false)
        for (const op of afterWipe)
          ops.push({ op, result: "not checked", why: `the wipe failed: ${wipedDm.error ?? JSON.stringify(wipedDm)}`, tries: [] });
      else {
        ops.push({
          op: afterWipe[0],
          ...(await operate(ctx, ws, {
            asks: DM_READ_ASKS.map((f) => f(DM_WIPED_READ.thing, dm)),
            methods: ["conversations.history", "conversations.replies"],
            ids: [dm],
            judge: async (a) => holds(a.reply, DM_WIPED_READ.mark),
          })),
        });
        ops.push({
          op: afterWipe[1],
          ...(await operate(ctx, ws, searchOpts(DM_WIPED, DM_SEARCH_ASKS.map((f) => f(DM_WIPED.word, dm))))),
        });
      }

      await seed(WIPED);
      const wiped = await wipe(news, [WIPED.found.text, WIPED.found.mark]);
      evidence.wipeNews = wiped;
      if (wiped?.ok === false) observations["search after wipe (#news)"] = { notChecked: wiped.error ?? wiped };
      else {
        await groupCheck("search after wipe (#news)", searchOpts(WIPED, NAMED_SEARCH_ASKS.map((f) => f(WIPED.word, g))));
        const a = await askConcierge(ctx, ctx.a, SEARCH_ASKS[0](WIPED.word));
        observations.unnamedSearchAfterWipe = { found: holds(a.reply, WIPED.found.mark), reply: a.reply.slice(0, 300) };
      }
    }
    if (scoreGroups) {
      ops.push({
        op: "list groups",
        ...(await operate(ctx, ws, {
          asks: LIST_ASKS.map((f) => f()),
          methods: ["conversations.list", "users.conversations"],
          ids: [],
          judge: async (a) => /\bnews\b/i.test(a.reply) && /\bgeneral\b/i.test(a.reply),
        })),
      });
      const before = await ctx.slack.seq();
      const asked = await askConcierge(ctx, ctx.a, QUIET_ASK(g));
      const readOk = (await ctx.slack.calls({ team: ws.id, since: before })).filter(
        (c) => ["conversations.history", "conversations.replies"].includes(c.method) && c.args?.channel === quiet && c.ok,
      );
      const shown = QUIET_MARKS.some((m) => holds(asked.reply, m));
      ops.push({
        op: "read in #quiet refused",
        result: readOk.length || shown ? "fail" : "pass",
        why: readOk.length ? "a read of #quiet succeeded at Slack" : shown ? "the reply showed #quiet's messages" : "nothing from #quiet was read or shown",
        tries: [{ asked: QUIET_ASK(g), reply: asked.reply.slice(0, 300) }],
      });
    }
    for (const [i, f] of REFUSALS.entries()) {
      const text = f(g);
      const asked = await askConcierge(ctx, ctx.a, text);
      const reactions = await ctx.slack.calls({ team: ws.id, method: "reactions.add", since: asked.since });
      ops.push({
        op: `refusal ${i + 1}`,
        result: reactions.length ? "fail" : "pass",
        why: reactions.length
          ? `reactions.add reached Slack ${reactions.length} time(s)`
          : "no reactions.add reached Slack",
        tries: [{ asked: text, reply: asked.reply.slice(0, 300) }],
      });
    }
  } finally {
    await ctx.slack.config({ history_limit: limitWas });
  }
  evidence.operations = ops;
  // A search's coverage statement, where the listing shows results.
  const coverage = ops
    .filter((o) => o.op.startsWith("search"))
    .flatMap((o) => o.tries ?? [])
    .map((t) => t.coverage);
  observations.coverage = coverage.every((c) => c === null || c === undefined)
    ? "not observed (the action listing shows no results)"
    : coverage.filter((c) => c !== null && c !== undefined);
  evidence.observations = observations;

  // Across R9's asks: no user token anywhere, no reaction, no #quiet value.
  // Only from R9's start, since the old kinds seeded for R10 may hold a user
  // token of their own.
  const calls = await ctx.slack.calls({ since: startSeq });
  const userCalls = calls.filter((c) => c.tokenKind === "user");
  const reactionCalls = calls.filter((c) => c.method === "reactions.add");
  const posts = await ctx.slack.posts({ team: ws.id, since: startSeq });
  const outsideMarks = [...SEARCHES.map((q) => q.outside.mark), "marmalade"];
  const leaks = [
    ...posts.map((p) => ({ where: p.channel, text: p.text })),
    ...ctx.dashboardReplies.map((r) => ({ where: "dashboard chat", text: r.reply })),
  ].filter((l) => outsideMarks.some((m) => holds(l.text, m)));
  ctx.dashboardReplies = undefined;
  evidence.timeline = ctx.r9Timeline;
  ctx.r9Timeline = undefined;
  evidence.userTokenCalls = userCalls.map((c) => ({ seq: c.seq, method: c.method, teamId: c.teamId }));
  evidence.reactionCalls = reactionCalls.length;
  evidence.leaks = leaks.map((l) => ({ where: l.where, text: l.text.slice(0, 200) }));

  // No token file for the new kind on the instance.
  let tokenFile;
  try {
    tokenFile = await ctx.a.tokenFile();
  } catch (err) {
    tokenFile = { error: err.message };
  }
  const tail = w?.bot_token_tail ?? null;
  evidence.tokenFile = { probe: tokenFile, newConnectionTail: tail };
  let tokenFileVerdict;
  if (!tokenFile || tokenFile.error) tokenFileVerdict = { ok: null, said: "not checked (no probe)" };
  else if (!tokenFile.exists) tokenFileVerdict = { ok: true, said: "absent" };
  else if (tail)
    tokenFileVerdict =
      tokenFile.bot_token_tail === tail
        ? { ok: false, said: "holds the new connection's bot token" }
        : { ok: true, said: "present, without the new connection's token" };
  else tokenFileVerdict = { ok: null, said: "present; whose token it holds cannot be told" };
  evidence.tokenFile.verdict = tokenFileVerdict.said;

  const list = ops.map((o) => `${o.op} ${o.result} (${o.why})`).join("; ");
  const problems = [];
  for (const o of ops.filter((x) => x.result === "fail")) problems.push(`${o.op} failed`);
  if (userCalls.length) problems.push(`${userCalls.length} Slack call(s) carried a user token`);
  if (reactionCalls.length) problems.push("reactions.add reached Slack");
  if (leaks.length) problems.push(`${leaks.length} post(s) or dashboard repl(ies) showed a message from #quiet, which the app is not in`);
  if (tokenFileVerdict.ok === false) problems.push(`the token file ${tokenFileVerdict.said}`);
  if (Array.isArray(observations.coverage) && observations.coverage.includes(false))
    problems.push("a search's result carries no coverage statement");
  const unchecked = ops.filter((o) => o.result === "not checked").map((o) => o.op);
  if (tokenFileVerdict.ok === null) unchecked.push(`token file ${tokenFileVerdict.said}`);
  const seen = (b) => (b === undefined ? "not asked" : b ? "yes" : "no");
  const tally =
    `user-token calls ${userCalls.length}; #quiet values shown ${leaks.length}; token file ${tokenFileVerdict.said}; ` +
    `coverage ${Array.isArray(observations.coverage) ? "checked" : "not observed"}. ` +
    (scoreGroups ? "Group checks scored (--r9-groups). " : `Unscored group checks: ${groupSummary(observations)}; `) +
    `a search naming no chat found the value after the wipe ${seen(observations.unnamedSearchAfterWipe?.found)}`;
  if (problems.length) return { ok: false, reason: `${problems.join("; ")}. ${list}; ${tally}`, evidence };
  if (unchecked.length)
    return { ok: null, reason: `not all checked (${unchecked.join(", ")}). ${list}; ${tally}`, evidence };
  return { ok: true, reason: `${list}; ${tally}`, evidence };
}

/**
 * R9. Provisional reading ("read, search and send only", until Ouou rules):
 * the existing tests pass unchanged, and a live check of the new connection.
 */
export async function r9(ctx) {
  if (!ctx.bound.a) return { result: "not checked", reason: "R1 made no connection to build on." };
  const tests = await existingTests(ctx.env);
  const live = await liveCheck(ctx);
  const evidence = { tests: tests.evidence, live: live.evidence ?? null };
  if (tests.ok === false)
    return {
      result: "fail",
      reason: `Provisional reading. Existing tests: ${tests.reason}. Live: ${live.reason}.`,
      evidence,
    };
  if (tests.ok === null || live.ok === null)
    return {
      result: "not checked",
      reason: `Provisional reading${ctx.env.r9?.groups ? ", groups scored" : ""}. Existing tests: ${tests.reason}. Live: ${live.reason}.`,
      evidence,
    };
  return {
    result: live.ok ? "pass" : "fail",
    reason: `Provisional reading${ctx.env.r9?.groups ? ", groups scored" : ""}. Existing tests: ${tests.reason}. Live: ${live.reason}.`,
    evidence,
  };
}

// R10 ---------------------------------------------------------------------
//
// Connect shows one Slack entry; slack_bot and the old OAuth slack can no
// longer be newly connected; the ones an upgrade leaves keep working, across
// a restart, until the guardian disconnects them, after which they cannot
// be connected again. Runs last, on the second instance, since seeding the
// old OAuth kind writes the connector's token file there.

const SLACK = /slack/i;

const OLD_KINDS = ["slack_bot", "slack"];

/** An entry's visible name: the API's display name when it gives one, else "Slack". */
function visibleName(c) {
  const named = c?.displayName ?? c?.display_name ?? c?.name ?? c?.title;
  if (typeof named === "string" && named) return named;
  // A label that is the kind itself ("slack_app") is not what the page shows.
  if (typeof c?.label === "string" && c.label && c.label !== c.connectionKind && !/^[a-z0-9]+_[a-z0-9_]+$/.test(c.label)) return c.label;
  return "Slack";
}

/**
 * The Slack entries Connect shows (`GET /connections`), connected or not:
 * `official` counts the official kind's, `oldOffered` the old kinds still
 * offered for a new connection (a placeholder, id null).
 */
async function pickerSlack(inst, officialKind) {
  const res = await inst.call("/connections");
  if (!res.ok) return { error: `GET /connections: ${res.status}` };
  const list = Array.isArray(res.data) ? res.data : (res.data?.connections ?? []);
  const entries = list
    .filter((c) => SLACK.test(c.connectionKind ?? "") || SLACK.test(c.label ?? ""))
    .map((c) => ({ id: c.id ?? null, kind: c.connectionKind, label: c.label }));
  const official = entries.filter((e) => e.kind === officialKind);
  const oldOffered = entries.filter((e) => e.id === null && OLD_KINDS.includes(e.kind));
  return { entries, official: official.length, officialLabel: visibleName(list.find((c) => c.connectionKind === officialKind)), oldOffered: oldOffered.length };
}

/**
 * The Slack entries the dashboard's Connections page offers under "Add a
 * connection", by visible name, read once the names render.
 */
async function pickerPage(ctx, inst, label) {
  let chromium;
  const remote = ctx.env.browser?.ws_endpoint;
  try {
    if (remote) {
      const { pathToFileURL } = await import("node:url");
      const from = ctx.env.browser.import ?? `${ctx.env.browser.client}/node_modules/playwright-core/index.mjs`;
      ({ chromium } = await import(from.startsWith("/") ? pathToFileURL(from).href : from));
    } else {
      const { createRequire } = await import("node:module");
      ({ chromium } = createRequire(import.meta.url)("playwright"));
    }
  } catch (err) {
    return { error: `no browser: ${err.message}` };
  }
  let browser;
  try {
    browser = remote ? await chromium.connect(remote) : await chromium.launch();
    const context = await browser.newContext();
    const cookie = inst.headers?.cookie;
    if (cookie)
      await context.addCookies(
        cookie.split(/;\s*/).map((kv) => {
          const i = kv.indexOf("=");
          return { name: kv.slice(0, i), value: kv.slice(i + 1), url: inst.origin };
        }),
      );
    const page = await context.newPage();
    const url = `${inst.origin}/settings/connections`;
    const startedAt = Date.now();
    const res = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60_000 });
    // The list renders after its fetch: wait for the names under "Add a
    // connection", not for the network.
    const linesAfter = () => {
      const lines = document.body.innerText.split("\n").map((x) => x.trim()).filter(Boolean);
      const at = lines.findIndex((x) => /^add a connection$/i.test(x));
      return at < 0 ? null : lines.slice(at + 1);
    };
    try {
      await page.waitForFunction(`(${linesAfter})()?.length > 0`, null, { timeout: 30_000 });
    } catch {
      const seen = (await page.evaluate(() => document.body.innerText)).slice(0, 500);
      return { url, status: res?.status() ?? null, error: `no names under "Add a connection" after 30 s (page began: ${JSON.stringify(seen)})` };
    }
    await page.waitForTimeout(1000);
    const lines = (await page.evaluate(() => document.body.innerText)).split("\n").map((x) => x.trim()).filter(Boolean);
    const at = lines.findIndex((x) => /^add a connection$/i.test(x));
    const offered = lines.slice(at + 1);
    return {
      url,
      status: res?.status() ?? null,
      renderedMs: Date.now() - startedAt,
      label,
      offeredSlack: offered.filter((x) => /slack/i.test(x)),
      exactLabel: offered.filter((x) => x === label).length,
      slackLines: lines.filter((x) => /slack/i.test(x)).slice(0, 20),
    };
  } catch (err) {
    return { error: err.message };
  } finally {
    await browser?.close();
  }
}

/** Starts a new connection of `kind` through its public route; true when refused. */
async function newConnectRefused(inst, kind) {
  if (kind === "slack_bot") {
    const res = await inst.call("/connections/slack_bot/grants/bot/setup", { method: "POST", body: {} });
    const state = res.data?.state;
    const refused = !res.ok || state?.status === "failed";
    return { route: "POST /api/connections/slack_bot/grants/bot/setup", status: res.status, state: state?.status ?? null, refused };
  }
  // The old OAuth kind's start: refused unless it answers 2xx or sends the
  // browser on to a sign-in.
  const res = await fetch(`${inst.origin}/api/oauth/slack/start`, {
    redirect: "manual",
    headers: { origin: inst.origin, "sec-fetch-site": "same-origin", ...(inst.headers ?? {}) },
  });
  const location = res.headers.get("location");
  const refused = res.status >= 400 || (res.status >= 300 && res.status < 400 && /error|denied|unavailable/i.test(location ?? ""));
  return { route: "GET /api/oauth/slack/start", status: res.status, location, refused };
}

/** The guardian's direct message id in `team`, as the fake names it. */
async function guardianDm(ctx, team, user) {
  const w = (await ctx.slack.state()).workspaces.find((x) => x.id === team);
  return w?.members?.find((m) => m.id === user)?.im_channel ?? null;
}

/** slack_bot sends: the bot hears a direct message over Socket Mode and answers from its own app. */
async function botSends(ctx, ws, bot) {
  const dm = await guardianDm(ctx, ws.id, ws.guardian);
  const tries = [];
  for (let i = 1; i <= 3; i++) {
    const since = await ctx.slack.seq();
    let pushed;
    try {
      pushed = await ctx.slack.socketEvent(bot.app_id, {
        type: "message",
        channel_type: "im",
        channel: dm,
        user: ws.guardian,
        text: `Hello, could you say hello back? (R10 check ${i})`,
        ts: `${Math.floor(Date.now() / 1000)}.${String(i).padStart(6, "0")}`,
      });
    } catch (err) {
      tries.push({ error: err.message });
      continue;
    }
    await replyAfter(ctx.slack, { team: ws.id, channel: dm, since, timeoutMs: ctx.env.timeouts.replySeconds * 1000 });
    const posts = (await ctx.slack.posts({ team: ws.id, channel: dm, since })).filter((p) => p.appId === bot.app_id);
    tries.push({ acked: pushed?.acked ?? null, replies: posts.length });
    if (posts.length) return { ok: true, tries };
  }
  return { ok: false, tries };
}

/** The old OAuth slack sends: a Concierge post to #general arrives from that app. */
async function oauthSends(ctx, ws, oauth, sentence, markWord, asks = SEND_ASKS) {
  const w = (await ctx.slack.state()).workspaces.find((x) => x.id === ws.id);
  const general = w?.groups?.find((g) => g.name === "general")?.id;
  const marked = async (since) =>
    (await ctx.slack.posts({ team: ws.id, channel: general, since })).filter((p) => holds(p.text, markWord));
  const tries = [];
  for (const f of asks) {
    const asked = await askConcierge(ctx, ctx.b, f(sentence, { general }), {
      right: async (a) => (await marked(a.since)).length > 0,
    });
    const posts = await marked(asked.since);
    tries.push({
      at: new Date(asked.at).toISOString(),
      waitedSeconds: asked.waitedSeconds,
      posts: posts.map((p) => ({ appId: p.appId ?? null, tokenKind: p.tokenKind })),
      reply: asked.reply.slice(0, 200),
    });
    const fromOld = posts.some((p) => p.appId === oauth.app_id);
    if (fromOld) return { ok: true, tries, fromApps: posts.map((p) => p.appId) };
    if (posts.length) return { ok: false, tries, fromApps: posts.map((p) => p.appId), why: "the post came from another app" };
  }
  return { ok: null, tries, why: `no post arrived in ${asks.length} ask(s)` };
}

export async function r10(ctx) {
  const inst = ctx.b;
  const ws = ctx.wsB;
  const evidence = {};
  const problems = [];
  const unchecked = [];

  // The picker, before the old kinds exist.
  const officialKind = ctx.env.instances[1]?.connect?.kind ?? "slack_app";
  const pickerProblems = (p, when) => {
    if (p.error) return unchecked.push(`picker ${when}: ${p.error}`);
    if (p.official !== 1) problems.push(`Connect shows ${p.official} entries of the official kind ${when}, not 1`);
    if (p.oldOffered) problems.push(`Connect offers ${p.oldOffered} old Slack kind(s) for a new connection ${when}`);
  };
  const before = await pickerSlack(inst, officialKind);
  evidence.pickerBefore = before;
  pickerProblems(before, "before the upgrade");

  // Neither old kind can be newly connected, even before any exists.
  for (const kind of ["slack_bot", "slack"]) {
    const r = await newConnectRefused(inst, kind);
    evidence[`newConnect_${kind}`] = r;
    if (!r.refused) problems.push(`a new ${kind} connection could be started (${r.route} answered ${r.status})`);
  }

  // The upgrade: the environment writes the old connections in.
  let old;
  try {
    old = await inst.seedOldConnections();
  } catch (err) {
    evidence.seed = err.message;
    return { result: "not checked", reason: `the environment's seed of the old connections failed: ${err.message.slice(0, 300)}`, evidence };
  }
  if (!old)
    return { result: "not checked", reason: "the environment gives no seed of the old connections", evidence };
  evidence.seed = old;
  const bot = old.slack_bot;
  const oauth = old.slack;
  if (!bot?.connection_id || !oauth?.connection_id)
    return { result: "not checked", reason: "the seed named no slack_bot or slack connection", evidence };

  const after = await pickerSlack(inst, officialKind);
  evidence.pickerAfter = after;
  pickerProblems(after, "with the old connections present");
  const page = await pickerPage(ctx, inst, after.officialLabel ?? before.officialLabel);
  evidence.pickerPage = page;
  if (page.error) unchecked.push(`the page part (read in a browser): ${page.error}`);
  else if (page.offeredSlack.length > 1)
    problems.push(`the Connections page offers ${page.offeredSlack.length} Slack entries under "Add a connection" (${page.offeredSlack.join(", ")}), not one`);

  // Unscored: with both present, which app a Concierge send comes from.
  const both = await oauthSends(ctx, ws, oauth, "The harvest supper is at the Larkholme barn.", "Larkholme", SEND_ASKS.slice(0, 1));
  evidence.observations = { bothPresentSendFrom: both.fromApps ?? null, bothPresent: both };

  // The old kinds are scored alone: the official app on this instance is
  // disconnected first, since with both present the product sends as the app.
  const officialHeld = after.entries?.filter((e) => e.kind === officialKind && e.id) ?? [];
  let alone = true;
  for (const e of officialHeld) {
    try {
      await inst.disconnect(e.id);
    } catch (err) {
      alone = false;
      evidence.officialDisconnect = err.message;
    }
  }
  evidence.officialDisconnected = officialHeld.map((e) => e.id);

  // Each old kind still sends, before and after a restart.
  const sends = {};
  for (const when of ["before restart", "after restart"]) {
    if (when === "after restart") {
      await inst.stop();
      await inst.start();
      const up = Date.now() + ctx.env.timeouts.restartSeconds * 1000;
      while (Date.now() < up && !(await inst.up())) await sleep(1000);
      await sleep(ctx.env.timeouts.settleSeconds * 1000);
    }
    const b = await botSends(ctx, ws, bot);
    const word = when === "before restart" ? "Corrandale" : "Pellbrook";
    const o = await oauthSends(ctx, ws, oauth, `The harvest supper is at the ${word} barn.`, word);
    sends[when] = { slack_bot: b, slack: o };
    if (!b.ok) problems.push(`slack_bot's reply did not arrive ${when}`);
    if (!alone) unchecked.push(`the old OAuth slack's send ${when}: the official app could not be disconnected first`);
    else if (o.ok === false) problems.push(`the old OAuth slack's send ${when} came from ${o.fromApps.join(", ")}, not its app ${oauth.app_id}`);
    else if (o.ok === null) unchecked.push(`the old OAuth slack's send ${when}: ${o.why}`);
  }
  evidence.sends = sends;

  // Disconnected, neither can be connected again.
  for (const [kind, c] of [["slack_bot", bot], ["slack", oauth]]) {
    try {
      await inst.disconnect(c.connection_id);
    } catch (err) {
      problems.push(`disconnecting ${kind} failed: ${err.message}`);
      continue;
    }
    const r = await newConnectRefused(inst, kind);
    evidence[`reconnect_${kind}`] = r;
    if (!r.refused) problems.push(`after the disconnect, ${kind} could be connected again (${r.route} answered ${r.status})`);
  }
  const final = await pickerSlack(inst, officialKind);
  evidence.pickerFinal = final;
  pickerProblems(final, "after the disconnects");

  const said = (o) => (o.ok ? "yes" : o.ok === false ? "no" : "not seen");
  const summary =
    `Official Slack entries in Connect: ${before.official ?? "?"} before, ${after.official ?? "?"} after the upgrade, ${final.official ?? "?"} at the end; under "Add a connection" on the page ${page.error ? "not read" : page.offeredSlack.length}; old kinds offered: ${before.oldOffered ?? "?"}/${after.oldOffered ?? "?"}/${final.oldOffered ?? "?"}. ` +
    `New slack_bot and slack refused: ${evidence.newConnect_slack_bot.refused && evidence.newConnect_slack.refused ? "yes" : "no"}. ` +
    `slack_bot answered before/after restart: ${said(sends["before restart"].slack_bot)}/${said(sends["after restart"].slack_bot)}; ` +
    `old slack (official app disconnected) sent before/after restart: ${said(sends["before restart"].slack)}/${said(sends["after restart"].slack)}. ` +
    `Reconnect after disconnect refused: ${evidence.reconnect_slack_bot?.refused && evidence.reconnect_slack?.refused ? "yes" : "no"}. ` +
    `Unscored: with the official app also connected, the send came from ${both.fromApps?.join(", ") || "no app"}.`;
  if (problems.length) return { result: "fail", reason: `${problems.join("; ")}. ${summary}`, evidence };
  if (unchecked.length) return { result: "not checked", reason: `not all checked (${unchecked.join("; ")}). ${summary}`, evidence };
  return { result: "pass", reason: summary, evidence };
}
