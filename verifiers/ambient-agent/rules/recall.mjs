// Rules 1 and 3: a fact said without mentioning the agent, ten more
// messages, then a mention asking for it; the reply must hold the fact's
// value. Rule 3 stops the instance before the fact and starts it before the
// mention.

import { lastJson, run } from "../lib/control.mjs";
import { pace } from "../lib/pace.mjs";
import { drawFacts, factText, fillers, holdsValue, questionText } from "../lib/scenario.mjs";

const ROUNDS = 10;
const PASS_AT = 9;
const OTHER_MESSAGES = 10;

/**
 * Collects what the app posted in the chat after `since`: waits up to
 * `ctx.replyMs` for the first post, then `ctx.afterReplyMs` for any more.
 */
export async function replyAfter(ctx, since) {
  const deadline = Date.now() + ctx.replyMs;
  for (;;) {
    const posts = await ctx.slack.posts({ team: ctx.team, channel: ctx.channel, since });
    if (posts.length) {
      await ctx.sleep(ctx.afterReplyMs);
      return ctx.slack.posts({ team: ctx.team, channel: ctx.channel, since });
    }
    if (Date.now() >= deadline) return [];
    await ctx.sleep(1000);
  }
}

// Person A writes the fact and person B asks: two members who are not the
// guardian, turn about. Everyone else in the chat writes the other messages.
async function round(ctx, fact, i, { thread = false, hooks = {}, asker: askedBy } = {}) {
  const p = ctx.people;
  const writer = p[i % p.length];
  const asker = askedBy ?? p[(i + 1) % p.length];
  const others = ctx.members.filter((x) => x !== writer);
  const ev = {
    round: i + 1,
    thread,
    topic: fact.topic,
    value: fact.value,
    askedByGuardian: asker === ctx.guardian,
  };
  const t0 = Date.now();
  if (hooks.beforeWrite) Object.assign(ev, await hooks.beforeWrite());
  if (ev.controlFault) return ev;
  const said = await ctx.slack.groupMessage(ctx.team, writer, ctx.channel, factText(fact, i));
  ev.fact = { ts: said.ts, by: writer };
  let lastTs = said.ts;
  let eventsSent = said.eventSent ? 1 : 0;
  for (const [k, text] of fillers(OTHER_MESSAGES).entries()) {
    const r = await ctx.slack.groupMessage(ctx.team, others[k % others.length], ctx.channel, text);
    lastTs = r.ts;
    if (r.eventSent) eventsSent += 1;
  }
  ev.otherMessages = OTHER_MESSAGES;
  ev.groupMessageEventsSent = eventsSent;
  if (hooks.beforeMention) Object.assign(ev, await hooks.beforeMention());
  if (ev.controlFault) return ev;
  ev.waitedForLimitMs = await pace(ctx);
  const since = await ctx.slack.seq();
  const asked = await ctx.slack.mention(
    ctx.team,
    asker,
    ctx.channel,
    questionText(fact, i),
    thread ? lastTs : undefined,
  );
  ev.mention = {
    ts: asked.ts,
    by: asker,
    threadTs: thread ? lastTs : null,
    eventSent: asked.eventSent,
  };
  const posts = await replyAfter(ctx, since);
  ev.replies = posts.map((p) => ({ ts: p.ts, threadTs: p.threadTs ?? null, text: p.text }));
  ev.answered = posts.length > 0;
  ev.held = posts.some((p) => holdsValue(p.text, fact));
  ev.ms = Date.now() - t0;
  ctx.log(
    `  round ${i + 1}${thread ? " (thread)" : ""}${ev.askedByGuardian ? " (the guardian asks)" : ""}: ${ev.held ? "held" : ev.answered ? "reply without the value" : "no reply"}, waited ${Math.round(ev.waitedForLimitMs / 1000)} s for the limit`,
  );
  return ev;
}

/** Whether so many rounds missed that the bar can no longer be met, so the rest are not asked. */
const beyondBar = (rounds) => rounds.filter((r) => !r.held).length > ROUNDS - PASS_AT;

function score(rounds, notCounted = {}) {
  const held = rounds.filter((r) => r.held).length;
  const answered = rounds.filter((r) => r.answered).length;
  const evidence = {
    held,
    answered,
    of: rounds.length,
    passAt: PASS_AT,
    rounds,
    ...(notCounted.thread?.length ? { threadRoundsNotCounted: notCounted.thread } : {}),
    ...(notCounted.guardian ? { guardianRoundNotCounted: notCounted.guardian } : {}),
  };
  const g = notCounted.guardian;
  const guardianNote = g
    ? `; the extra round where the guardian asked (not counted): ${g.held ? "held the fact" : g.answered ? "answered without the fact" : "no reply"}`
    : "";
  if (held >= PASS_AT)
    return {
      result: "pass",
      reason: `${held} of ${rounds.length} facts held${guardianNote}`,
      evidence,
    };
  const parts = [`${held} of ${rounds.length} facts held (bar ${PASS_AT} of ${ROUNDS})`];
  if (answered === 0)
    parts.push(`the agent did not answer a member's mention: none of ${rounds.length} got a reply`);
  else {
    if (rounds.length - answered)
      parts.push(`${rounds.length - answered} member's mention(s) got no reply`);
    if (answered - held) parts.push(`${answered - held} answered without the fact`);
  }
  if (rounds.length < ROUNDS)
    parts.push(
      `stopped after ${rounds.length} of ${ROUNDS} rounds, as the bar could no longer be met`,
    );
  return { result: "fail", reason: parts.join("; ") + guardianNote, evidence };
}

/**
 * Rule 1: ten rounds in the open chat. Then, reported apart and not counted,
 * `ctx.threadRounds` with the mention in a thread, and one where the guardian
 * asks, which tells a mention left unanswered from one answered without the fact.
 */
export async function recall(ctx) {
  const facts = drawFacts(ROUNDS + ctx.threadRounds + 1, { exclude: ctx.usedTopics });
  ctx.usedTopics.push(...facts.map((f) => f.topic));
  const rounds = [];
  for (let i = 0; i < ROUNDS && !beyondBar(rounds); i++) rounds.push(await round(ctx, facts[i], i));
  const thread = [];
  for (let i = 0; i < ctx.threadRounds; i++)
    thread.push(await round(ctx, facts[ROUNDS + i], ROUNDS + i, { thread: true }));
  const n = ROUNDS + ctx.threadRounds;
  const guardian = await round(ctx, facts[n], n, { asker: ctx.guardian });
  return score(rounds, { thread, guardian });
}

/** The instance's state from its status control: running, starting or stopped. */
async function status(ctx) {
  const r = await run(ctx.env.instance.status, [], { timeoutMs: 60_000 });
  return (
    lastJson(r.stdout)?.state ??
    `unknown (exit ${r.code}: ${(r.stderr || r.stdout).trim().slice(-200)})`
  );
}

/** Rule 3: as rule 1, with the instance stopped while the fact and the ten messages are written. */
export async function stopped(ctx) {
  const facts = drawFacts(ROUNDS, { exclude: ctx.usedTopics });
  ctx.usedTopics.push(...facts.map((f) => f.topic));
  const hooks = {
    beforeWrite: async () => {
      const r = await run(ctx.env.instance.stop, [], { timeoutMs: ctx.restartMs });
      const state = await status(ctx);
      const stop = { exit: r.code, ms: r.ms, statusAfter: state };
      if (state !== "stopped")
        return {
          stop,
          controlFault: `the instance was not stopped (status: ${state}, stop exit ${r.code})`,
        };
      return { stop };
    },
    beforeMention: async () => {
      const r = await run(ctx.env.instance.start, [], { timeoutMs: ctx.restartMs });
      const deadline = Date.now() + ctx.restartMs;
      let state = await status(ctx);
      while (state !== "running" && Date.now() < deadline) {
        await ctx.sleep(2000);
        state = await status(ctx);
      }
      const start = { exit: r.code, ms: r.ms, statusAfter: state };
      if (state !== "running")
        return {
          start,
          controlFault: `the instance was not healthy after start (status: ${state}, start exit ${r.code})`,
        };
      return { start };
    },
  };
  const rounds = [];
  try {
    for (let i = 0; i < ROUNDS && !beyondBar(rounds); i++) {
      const ev = await round(ctx, facts[i], i, { hooks });
      rounds.push(ev);
      if (ev.controlFault)
        return {
          result: "not checked",
          reason: `environment fault in round ${i + 1}: ${ev.controlFault}`,
          evidence: { rounds },
        };
    }
  } finally {
    // Leave the instance running for whatever comes next, also when a round threw.
    const state = await status(ctx);
    if (state !== "running") await run(ctx.env.instance.start, [], { timeoutMs: ctx.restartMs });
  }
  return score(rounds);
}
