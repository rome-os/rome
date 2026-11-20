// R14, groups the app was added to (rule set v3, Ouou 2026-11-20): Rome's
// app may see the names and past messages of groups it is a member of, and
// nothing of other groups. The Concierge posts to such a group by its name,
// lists them, reads their recent messages, and a mention inside a thread
// reaches it with that thread's earlier messages. It still hears only direct
// messages and mentions as they happen. A workspace connected before these
// permissions keeps working for direct messages and mentions and is told to
// approve the app again for the rest.
//
// Scored through the agent and the fake Slack, never through the prompt.

import { phase, sleep } from "../lib/http.mjs";
import { replyAfter } from "../lib/replies.mjs";
import { connectAs } from "./connect.mjs";
import { askConcierge, holds, operate, SEARCH_ASKS } from "./phase3.mjs";

// The scopes the app asked for before it asked for groups.
export const OLD_SCOPES = "app_mentions:read,chat:write,im:history,im:read,im:write,users:read";

// A group the app is in, named only by its name.
const BY_NAME = {
  sentence: "The library book sale is on at the Coldharbour hall.",
  mark: "Coldharbour",
  asks: [
    (s) => `Please post this exact sentence in the #news channel: "${s}"`,
    (s) => `Could you send a message to #news on Slack saying: ${s}`,
    (s) => `Post to the news group on Slack, word for word: ${s}`,
  ],
};

const LIST_ASKS = [
  "Which Slack channels are you a member of? Please list them by name.",
  "List the Slack groups you are in, please.",
  "What Slack channels can you see as a member? Give me their names.",
];

// A plain message seeded in #news, not a mention, read back by name.
const READ = { text: "The bakery van now parks by the Quenby fountain.", mark: "Quenby" };
const READ_ASKS = [
  "What were the last few messages in the #news channel on Slack?",
  "Can you read the latest messages in #news and tell me what they say?",
  "Look at the news group on Slack: what has been said there most recently?",
];

// #quiet holds this; the app is not in #quiet.
const QUIET_MARKS = ["marmalade"];
const QUIET_ASK = (g) => `What were the last few messages in the #quiet channel (${g.quiet}) on Slack?`;

// A plain message in #news, then Rome's copy of #news wiped: a search naming
// #news must still find it.
const WIPED = {
  word: "lantern parade",
  text: "The lantern parade starts at Ebbridge Green.",
  mark: "Ebbridge",
};
const NAMED_SEARCH_ASKS = [
  (w) => `Search the #news channel on Slack for the message that mentions "${w}" and tell me what it said.`,
  (w) => `In the #news channel, find the message about the ${w} and tell me what it says.`,
  (w) => `Look up "${w}" in #news on Slack and tell me what you find.`,
];

// Thread facts: harmless ones (a name, a place), never anything called a
// code, password, key or PIN, which the Concierge rightly declines to repeat
// in a group. Each made-up word appears once, in an earlier reply of a thread;
// the guardian then mentions the app later in that thread with a question
// that needs it. The first two share the environment's seeded thread, so two
// mentions there test that the thread is read once.
const THREAD_FACTS = [
  { fact: "The harbour fair opens with a song called Quillfeather Morning.", ask: "which song opens the harbour fair?", mark: "Quillfeather" },
  { fact: "The lantern boat this year is called the Marrowdine.", ask: "what is the lantern boat called this year?", mark: "Marrowdine" },
  { fact: "The lost-and-found tent stands beside the Brackenspur oak.", ask: "where is the lost-and-found tent?", mark: "Brackenspur" },
  { fact: "The fireworks crew meets at the Tollywick jetty.", ask: "where does the fireworks crew meet?", mark: "Tollywick" },
  { fact: "The raffle prize is hidden in the Scarrowmoor crate.", ask: "which crate holds the raffle prize?", mark: "Scarrowmoor" },
];
const THREAD_TOPICS = [
  "Planning thread for the harbour fair stalls.",
  "Fireworks for the harbour fair, details here.",
  "Raffle for the harbour fair, details here.",
];

// A reply saying the thread could not be read (the product's words for a
// thread read that failed even after waiting for Slack's pace).
const UNREAD = /(could ?n[o']t|can ?n[o']t|unable to|was ?n[o']t able to|failed to)\b[^.]*\b(read|load|open|see|fetch|get)\b[^.]*\bthread|thread\b[^.]*\b(could ?n[o']t|can ?n[o']t) be read/i;
const ERRORISH = /missing_scope|not_in_channel|error|could not|couldn't|failed/i;
const REAPPROVE = /approv\w*\b[^.]*\bagain|re-?approv/i;

const now = () => new Date().toISOString();

/** The app's posts in a thread of `channel` after `since`. */
async function threadReplies(ctx, team, channel, threadTs, since) {
  return (await ctx.slack.posts({ team, channel, since })).filter((p) => p.threadTs === threadTs && p.tokenKind === "bot");
}

/**
 * A mention in a thread, and the app's reply in that thread. Returns the
 * control call's answer, the reply posts and the replies calls it caused.
 */
async function mentionInThread(ctx, ws, { user, channel, text, threadTs }) {
  const since = await ctx.slack.seq();
  const at = now();
  const sent = await ctx.slack.mention(ws.id, user, text, channel, { thread_ts: threadTs });
  // A thread read waits for Slack's pace on conversations.replies (one a
  // minute per workspace), so the reply may take that long on top of the
  // model's time.
  const budget = ctx.env.timeouts.replySeconds + ctx.env.timeouts.threadReadSeconds;
  await replyAfter(ctx.slack, { team: ws.id, channel, since, timeoutMs: budget * 1000 });
  await sleep(ctx.env.timeouts.settleSeconds * 1000);
  const replies = await threadReplies(ctx, ws.id, channel, threadTs, since);
  const repliesCalls = (await ctx.slack.calls({ team: ws.id, method: "conversations.replies", since })).filter(
    (c) => c.args?.channel === channel && c.args?.ts === threadTs,
  );
  return {
    at,
    control: sent,
    waitedUpToSeconds: budget,
    replies: replies.map((p) => ({ seq: p.seq, text: p.text?.slice(0, 300) })),
    repliesCalls: repliesCalls.length,
    repliesCallResults: repliesCalls.map((c) => (c.ok ? "ok" : c.error ?? "refused")),
    since,
  };
}

/** Workspace A, on the first instance: the group checks proper. */
async function inGroups(ctx, timeline) {
  const ws = ctx.wsA;
  const state = await ctx.slack.state();
  const w = state.workspaces.find((x) => x.id === ws.id);
  const group = (name) => w?.groups?.find((g) => g.name === name);
  const general = group("general")?.id;
  const news = group("news");
  const quiet = group("quiet");
  if (!general || !news || !quiet) return { ops: [], unchecked: ["the fake has no #general, #news and #quiet in workspace A"] };
  const g = { general, news: news.id, quiet: quiet.id };
  const member = news.members.find((m) => m !== ws.guardian);
  const other = news.members.find((m) => m !== ws.guardian && m !== member) ?? member;
  const ops = [];
  const observations = {};

  phase("R14: send to #news by name");
  // Sends by name alone.
  ops.push({
    op: "send to #news by name",
    ...(await operate(ctx, ws, {
      asks: BY_NAME.asks.map((f) => f(BY_NAME.sentence)),
      methods: ["chat.postMessage", "conversations.list"],
      ids: [g.news],
      judge: async (a) =>
        (await ctx.slack.posts({ team: ws.id, channel: g.news, since: a.since })).some((p) => holds(p.text, BY_NAME.mark)),
    })),
  });

  phase("R14: list groups");
  // The groups it is in: #news and #general, never #quiet.
  const listed = await operate(ctx, ws, {
    asks: LIST_ASKS,
    methods: ["conversations.list", "users.conversations"],
    ids: [],
    judge: async (a) => /#?\bnews\b/i.test(a.reply) && /#?\bgeneral\b/i.test(a.reply),
  });
  const listedQuiet = (listed.tries ?? []).some((t) => /#?\bquiet\b/i.test(t.reply ?? ""));
  ops.push(
    listedQuiet
      ? { op: "list groups", result: "fail", why: "the list named #quiet, which the app is not in", tries: listed.tries }
      : { op: "list groups", ...listed },
  );

  phase("R14: read #news");
  // A plain message in #news, read back by name.
  timeline.push({ at: now(), step: "seed message in #news", text: READ.text, control: await ctx.slack.groupMessage(ws.id, member, READ.text, g.news) });
  ops.push({
    op: "read #news",
    ...(await operate(ctx, ws, {
      asks: READ_ASKS,
      methods: ["conversations.history", "conversations.replies", "conversations.list"],
      ids: [g.news],
      judge: async (a) => holds(a.reply, READ.mark),
    })),
  });

  phase("R14: read #quiet");
  // A read of #quiet is refused: no read succeeds at Slack, nothing shown.
  {
    const before = await ctx.slack.seq();
    const asked = await askConcierge(ctx, ctx.a, QUIET_ASK(g));
    const readOk = (await ctx.slack.calls({ team: ws.id, since: before })).filter(
      (c) => ["conversations.history", "conversations.replies"].includes(c.method) && c.args?.channel === g.quiet && c.ok,
    );
    const shown = QUIET_MARKS.some((m) => holds(asked.reply, m));
    ops.push({
      op: "read #quiet refused",
      result: readOk.length || shown ? "fail" : "pass",
      why: readOk.length ? "a read of #quiet succeeded at Slack" : shown ? "the reply showed #quiet's messages" : "nothing from #quiet was read or shown",
      tries: [{ asked: QUIET_ASK(g), reply: asked.reply.slice(0, 300), waitedSeconds: asked.waitedSeconds }],
    });
  }

  phase("R14: search #news after a wipe");
  // A search naming #news, after Rome's copy of #news is wiped.
  if (!ctx.a.canWipe()) ops.push({ op: "search #news after wipe", result: "not checked", why: "the environment cannot wipe a chat", tries: [] });
  else {
    timeline.push({ at: now(), step: "seed message in #news", text: WIPED.text, control: await ctx.slack.groupMessage(ws.id, member, WIPED.text, g.news) });
    const at = now();
    let wiped;
    try {
      wiped = await ctx.a.wipeChat(g.news, { texts: [WIPED.text, WIPED.mark] });
    } catch (err) {
      wiped = { ok: false, error: err.message };
    }
    timeline.push({ at, step: "wipe", conversation: g.news, done: now(), ok: wiped?.ok !== false });
    if (wiped?.ok === false)
      ops.push({ op: "search #news after wipe", result: "not checked", why: `the wipe failed: ${wiped.error ?? JSON.stringify(wiped)}`, tries: [] });
    else {
      ops.push({
        op: "search #news after wipe",
        ...(await operate(ctx, ws, {
          asks: NAMED_SEARCH_ASKS.map((f) => f(WIPED.word)),
          methods: null,
          ids: [g.news],
          judge: async (a) => holds(a.reply, WIPED.mark),
        })),
      });
      // Unscored: a search naming no chat.
      const a = await askConcierge(ctx, ctx.a, SEARCH_ASKS[0](WIPED.word));
      observations.unnamedSearchAfterWipe = { found: holds(a.reply, WIPED.mark), reply: a.reply.slice(0, 300) };
    }
  }

  phase("R14: mentions in threads");
  // A mention inside a thread carries the thread's earlier messages. The
  // first two facts go in the environment's seeded thread, each later one in
  // a thread of its own; every fact is in place before its mention, and
  // nothing is posted after a mention until its reply is judged.
  const seededRoot = news.seed_messages?.find((m) => !m.thread_ts && (news.seed_messages ?? []).some((r) => r.thread_ts === m.ts))?.ts;
  const threads = [];
  if (seededRoot) threads.push({ root: seededRoot, facts: THREAD_FACTS.slice(0, 2), seeded: true });
  const rest = seededRoot ? THREAD_FACTS.slice(2) : THREAD_FACTS;
  for (const [i, f] of rest.entries()) {
    const topic = THREAD_TOPICS[i % THREAD_TOPICS.length];
    const root = await ctx.slack.groupMessage(ws.id, other, topic, g.news);
    timeline.push({ at: now(), step: "thread root in #news", text: topic, control: root });
    threads.push({ root: root.ts, facts: [f] });
  }
  const answers = [];
  const twoMentions = { root: seededRoot ?? null, repliesCalls: 0 };
  // Slack's pace on thread reads is on for the mentions, as in production
  // for an app outside the Marketplace; the rest of R14 runs without it.
  await ctx.slack.config({ history_limit: true });
  for (const t of threads) {
    for (const f of t.facts) {
      const c = await ctx.slack.groupMessage(ws.id, member, f.fact, g.news, { thread_ts: t.root });
      timeline.push({ at: now(), step: "fact in a thread", thread: t.root, text: f.fact, control: c });
    }
    for (const f of t.facts) {
      const m = await mentionInThread(ctx, ws, { user: ws.guardian, channel: g.news, text: f.ask, threadTs: t.root });
      timeline.push({ at: m.at, step: "mention in a thread", thread: t.root, text: f.ask, control: m.control, replies: m.replies, repliesCalls: m.repliesCalls });
      const right = m.replies.some((r) => holds(r.text, f.mark));
      const unread = m.replies.find((r) => UNREAD.test(r.text ?? ""));
      answers.push({
        mark: f.mark,
        thread: t.root,
        replied: m.replies.length > 0,
        right,
        ...(unread && !right ? { saidThreadUnread: unread.text } : {}),
        repliesCalls: m.repliesCallResults,
      });
      if (t.seeded) twoMentions.repliesCalls += m.repliesCalls;
    }
  }
  await ctx.slack.config({ history_limit: false });
  // A reply that says the thread could not be read, or no reply within the
  // budget, fails like a wrong one: the product was asked and did not answer.
  const wrong = answers.filter((a) => a.replied && !a.right);
  const silent = answers.filter((a) => !a.replied);
  const right = answers.length - wrong.length - silent.length;
  ops.push({
    op: `mention in a thread (${answers.length} facts)`,
    result: wrong.length || silent.length ? "fail" : "pass",
    why: [
      `${right} of ${answers.length} replies stated the thread's earlier value`,
      wrong.length ? `lacking it: ${wrong.map((a) => `${a.mark}${a.saidThreadUnread ? " (said the thread could not be read)" : ""}`).join(", ")}` : "",
      silent.length
        ? `no reply within ${ctx.env.timeouts.replySeconds + ctx.env.timeouts.threadReadSeconds} s: ${silent.map((a) => a.mark).join(", ")}`
        : "",
    ]
      .filter(Boolean)
      .join("; "),
    answers,
  });
  if (seededRoot)
    ops.push({
      op: "thread read once for two mentions",
      result: twoMentions.repliesCalls <= 1 ? "pass" : "fail",
      why: `${twoMentions.repliesCalls} conversations.replies call(s) for thread ${seededRoot} across 2 mentions in it`,
      tries: [],
    });
  else ops.push({ op: "thread read once for two mentions", result: "not checked", why: "the environment seeds no thread in #news", tries: [] });

  phase("R14: plain message in #news");
  // Only direct messages and mentions are heard: a plain message in #news,
  // with Slack's message event sent as if the app had subscribed, gets no
  // reply and causes no Slack call (the turn itself is not visible here).
  {
    const since = await ctx.slack.seq();
    const text = "Plain note for the group: the tide tables are pinned by the Wexcombe door.";
    // Sent by the guardian, whom Rome answers whatever the members switch
    // says, so silence shows the message was not heard, not that the sender
    // was ignored.
    const c = await ctx.slack.groupMessage(ws.id, ws.guardian, text, g.news, { send_event: true });
    timeline.push({ at: now(), step: "plain message in #news with its event", text, control: c });
    await sleep((ctx.env.timeouts.replySeconds + ctx.env.timeouts.settleSeconds) * 1000);
    const posts = (await ctx.slack.posts({ team: ws.id, since })).filter((p) => p.tokenKind === "bot");
    const calls = (await ctx.slack.calls({ team: ws.id, since })).filter((x) => x.tokenKind === "bot");
    ops.push({
      op: "plain group message not heard",
      result: c.eventSent === false ? "not checked" : posts.length || calls.length ? "fail" : "pass",
      why:
        c.eventSent === false
          ? "Slack did not send the message event"
          : posts.length
            ? `the app posted ${posts.length} time(s) after it`
            : calls.length
              ? `the app made ${calls.length} Slack call(s) after it (${[...new Set(calls.map((x) => x.method))].join(", ")})`
              : "no post and no Slack call after it",
      tries: [],
    });
  }
  return { ops, observations };
}

/**
 * Workspace B on the second instance, signed in again under the old scopes:
 * direct messages and mentions (in a thread too) still work, and a group
 * read is answered with a message to approve the app again. The limit is
 * lifted and B signed in again at the end, as approving again would.
 */
async function oldPermissions(ctx, timeline) {
  const ws = ctx.wsB;
  const ops = [];
  const evidence = {};
  if (!ctx.bound.b) return { ops: [{ op: "old permissions", result: "not checked", why: "the second instance holds no connection to workspace B", tries: [] }], evidence };
  let limited;
  try {
    limited = await ctx.slack.grantLimit(ws.id, OLD_SCOPES);
  } catch (err) {
    return { ops: [{ op: "old permissions", result: "not checked", why: `the fake sets no grant limit: ${err.message}`, tries: [] }], evidence };
  }
  evidence.limit = limited;
  try {
    const walk = await connectAs(ctx, ctx.b, ws).catch((e) => ({ outcome: "stuck", reason: e.message }));
    evidence.signInOld = { outcome: walk.outcome, reason: walk.reason ?? null };
    timeline.push({ at: now(), step: "sign in again under the old scopes", workspace: ws.id, outcome: walk.outcome });
    const state = await ctx.slack.state();
    const w = state.workspaces.find((x) => x.id === ws.id);
    evidence.scopes = w?.scopes ?? null;
    if (walk.outcome !== "connected" || (w?.scopes ?? []).includes("channels:history"))
      return {
        ops: [{ op: "old permissions", result: "not checked", why: walk.outcome !== "connected" ? `the sign-in under the old scopes ended ${walk.outcome}` : "the grant limit did not hold", tries: [] }],
        evidence,
      };
    const general = w.groups.find((g) => g.name === "general")?.id;
    const member = w.members.find((m) => m.id !== ws.guardian && !m.is_restricted && !m.is_ultra_restricted && !m.is_bot)?.id;

    phase("R14 old permissions: direct message");
    // A direct message from the guardian.
    {
      const since = await ctx.slack.seq();
      const sent = await ctx.slack.dm(ws.id, ws.guardian, "Hello, are you there? (R14 old permissions)");
      const ok = await replyAfter(ctx.slack, { team: ws.id, channel: sent.channel, since, timeoutMs: ctx.env.timeouts.replySeconds * 1000 });
      timeline.push({ at: now(), step: "direct message (old scopes)", control: sent, replied: ok });
      ops.push({ op: "old permissions: direct message answered", result: ok ? "pass" : "fail", why: ok ? "replied" : "no reply", tries: [] });
    }
    phase("R14 old permissions: mentions");
    // A mention, at the top of the group and inside a thread.
    {
      const since = await ctx.slack.seq();
      // The guardian: a fresh connection answers no one else (R12).
      const sent = await ctx.slack.mention(ws.id, ws.guardian, "hello from the group, are you there?", general);
      const ok = await replyAfter(ctx.slack, { team: ws.id, channel: general, since, timeoutMs: ctx.env.timeouts.replySeconds * 1000 });
      timeline.push({ at: now(), step: "mention (old scopes)", control: sent, replied: ok });
      ops.push({ op: "old permissions: mention answered", result: ok ? "pass" : "fail", why: ok ? "replied" : "no reply", tries: [] });
    }
    {
      const root = await ctx.slack.groupMessage(ws.id, member, "Thread for the Bayside picnic plans.", general);
      await ctx.slack.groupMessage(ws.id, ws.guardian, "The picnic blanket is in the Ravensworth van.", general, { thread_ts: root.ts });
      const m = await mentionInThread(ctx, ws, { user: ws.guardian, channel: general, text: "where is the picnic blanket?", threadTs: root.ts });
      timeline.push({ at: m.at, step: "mention in a thread (old scopes)", thread: root.ts, control: m.control, replies: m.replies });
      const erred = m.replies.filter((r) => ERRORISH.test(r.text ?? ""));
      ops.push({
        op: "old permissions: mention in a thread answered",
        result: !m.replies.length ? "fail" : erred.length ? "fail" : "pass",
        why: !m.replies.length ? "no reply in the thread" : erred.length ? `the thread got an error: ${erred[0].text.slice(0, 120)}` : "answered, with no error in the thread",
        tries: [],
      });
    }
    phase("R14 old permissions: group read");
    // A group read asked on the second instance's dashboard: answered with a
    // message to approve the app again.
    ops.push({
      op: "old permissions: group read asks to approve again",
      ...(await operate(ctx, ws, {
        inst: ctx.b,
        asks: [
          `What were the last few messages in the #general channel (${general}) on Slack?`,
          `Can you read the latest messages in #general (channel ${general}) and tell me what they say?`,
          `Look at the general group on Slack, ${general}: what has been said there most recently?`,
        ],
        methods: ["conversations.history", "conversations.replies"],
        ids: [general],
        judge: async (a) => REAPPROVE.test(a.reply),
      })),
    });
  } finally {
    // Approving again: the limit lifted and B signed in again.
    await ctx.slack.grantLimit(ws.id, null).catch(() => {});
    const walk = await connectAs(ctx, ctx.b, ws).catch((e) => ({ outcome: "stuck", reason: e.message }));
    evidence.signInAgain = { outcome: walk.outcome, reason: walk.reason ?? null };
    timeline.push({ at: now(), step: "limit lifted, signed in again", workspace: ws.id, outcome: walk.outcome });
  }
  return { ops, evidence };
}

export async function r14(ctx) {
  if (!ctx.bound.a) return { result: "not checked", reason: "R1 made no connection to build on." };
  // The product carries the group work when its app asks for group history.
  const a = (await ctx.slack.state()).workspaces.find((x) => x.id === ctx.wsA.id);
  if (!(a?.scopes ?? []).includes("channels:history"))
    return {
      result: "not checked",
      reason: `the product's app does not ask for group history (workspace A holds ${(a?.scopes ?? []).join(", ") || "no scopes"}), so this commit does not carry the group work`,
      evidence: { scopes: a?.scopes ?? null },
    };
  const timeline = [];
  const startSeq = await ctx.slack.seq();
  ctx.dashboardReplies = [];
  const state = await ctx.slack.state();
  const limitWas = state.history_limit?.on ?? true;
  await ctx.slack.config({ history_limit: false });
  let groups;
  let old;
  try {
    groups = await inGroups(ctx, timeline);
    old = await oldPermissions(ctx, timeline);
  } finally {
    await ctx.slack.config({ history_limit: limitWas });
  }
  // #quiet's values must show nowhere, on the dashboard or in Slack.
  const posts = await ctx.slack.posts({ team: ctx.wsA.id, since: startSeq });
  const leaks = [
    ...posts.filter((p) => p.tokenKind === "bot").map((p) => ({ where: p.channel, text: p.text })),
    ...ctx.dashboardReplies.map((r) => ({ where: "dashboard chat", text: r.reply })),
  ].filter((l) => QUIET_MARKS.some((m) => holds(l.text, m)));
  ctx.dashboardReplies = undefined;
  const ops = [...groups.ops, ...old.ops];
  if (leaks.length) ops.push({ op: "#quiet shown nowhere", result: "fail", why: `${leaks.length} post(s) or dashboard repl(ies) showed #quiet's messages`, tries: [] });
  const evidence = { operations: ops, observations: groups.observations, oldPermissions: old.evidence, leaks, timeline };
  const list = ops.map((o) => `${o.op} ${o.result} (${o.why})`).join("; ");
  const seen = (b) => (b === undefined ? "not asked" : b ? "yes" : "no");
  const tally = `Unscored: a search naming no chat found the #news value after the wipe ${seen(groups.observations?.unnamedSearchAfterWipe?.found)}.`;
  if (ops.some((o) => o.result === "fail")) return { result: "fail", reason: `${list}. ${tally}`, evidence };
  if (ops.some((o) => o.result === "not checked") || groups.unchecked?.length)
    return { result: "not checked", reason: `not all checked. ${list}. ${tally}`, evidence };
  return { result: "pass", reason: `${list}. ${tally}`, evidence };
}
