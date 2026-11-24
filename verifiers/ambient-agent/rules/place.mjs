// Rule 5: 50 mentions over 5 chats and 10 threads, in bursts of up to 10.
// Each asks the agent to say a value back, so a reply's place is read off
// the posts. Also, unscored, placement at bursts of 1, 3, 10 and 30.

import { lacks, pace, repeated } from "../lib/pace.mjs";
import { asked, awaitValues, judge, tally } from "../lib/places.mjs";
import { drawValues, echoText, fillers } from "../lib/scenario.mjs";

const CHATS = 5;
const THREADS_PER_CHAT = 2;
const MENTIONS = 50;
const BURST = 10;
const MAX_UNANSWERED = 1;

export function rightPlaceLacks(ctx) {
  return lacks(
    "shared chat(s) the app is in with a member who is not the guardian",
    ctx.chats.length,
    CHATS,
  );
}

/** The 5 chats and a fresh pair of threads in each: 15 places, each with the members who may ask there. */
async function places(ctx) {
  const chats = ctx.chats.slice(0, CHATS);
  const out = chats.map((c) => ({ channel: c.id, threadTs: null, people: c.people }));
  const openers = fillers(chats.length * THREADS_PER_CHAT);
  for (const [i, c] of chats.entries()) {
    for (let k = 0; k < THREADS_PER_CHAT; k++) {
      const r = await ctx.slack.groupMessage(
        ctx.team,
        c.people[k % c.people.length],
        c.id,
        openers[i * THREADS_PER_CHAT + k],
      );
      out.push({ channel: c.id, threadTs: r.ts, people: c.people });
    }
  }
  return out;
}

/**
 * Sends `plan` ({place, value}) in bursts of `size`: each burst's mentions go
 * out in one batch, at the same moment, then the verifier waits for their values. `stop(judged)` ends
 * the run early once the bar can no longer be met. Returns the judged
 * questions, the bursts' waits, and whether it stopped early.
 */
export async function inBursts(ctx, plan, size, since, stop = () => false) {
  const questions = [];
  const bursts = [];
  let stopped = false;
  for (let start = 0; start < plan.length; start += size) {
    const batch = plan.slice(start, start + size);
    const waited = await pace(ctx);
    const t0 = Date.now();
    const items = batch.map(({ place, value }, k) => ({
      kind: "mention",
      user: place.people[(start + k) % place.people.length],
      channel: place.channel,
      text: echoText(value, start + k),
      threadTs: place.threadTs ?? undefined,
    }));
    const results = await ctx.slack.batch(ctx.team, items);
    const sent = batch.map(({ place, value }, k) => ({
      channel: place.channel,
      threadTs: place.threadTs,
      ts: results[k].ts,
      by: items[k].user,
      value,
      eventSent: results[k].eventSent,
    }));
    questions.push(...sent);
    const posts = await awaitValues(
      ctx,
      sent,
      since,
      ctx.replyMs + batch.length * ctx.env.historyLimit.windowMs,
    );
    const judged = judge(questions, posts);
    const t = tally(judge(sent, posts));
    bursts.push({
      size: batch.length,
      waitedForLimitMs: waited,
      seconds: Math.round((Date.now() - t0) / 1000),
      ...t,
    });
    ctx.log(
      `    burst of ${batch.length}: ${t.answered} in place, ${t.misplaced} misplaced, ${t.unanswered} unanswered (waited ${Math.round(waited / 1000)} s for the limit)`,
    );
    if (stop(judged)) {
      stopped = start + size < plan.length;
      break;
    }
  }
  return { questions, bursts, stopped };
}

async function once(ctx) {
  const where = await places(ctx);
  const values = drawValues(MENTIONS);
  // Every place gets a mention before any gets a second, and a burst spreads
  // over chats and threads alike.
  const plan = values.map((value, i) => ({ value, place: where[(i * 7) % where.length] }));
  const since = await ctx.slack.seq();
  const failed = (judged) => {
    const t = tally(judged);
    return t.misplaced > 0 || t.unanswered > MAX_UNANSWERED;
  };
  const { questions, bursts, stopped } = await inBursts(ctx, plan, BURST, since, failed);
  // Late replies count: judge every question against every post so far.
  const posts = await ctx.slack.posts({ team: ctx.team, since });
  const judged = judge(questions, posts);
  const t = tally(judged);
  const evidence = {
    chats: CHATS,
    threads: where.length - CHATS,
    ...t,
    planned: plan.length,
    stoppedEarly: stopped,
    bursts,
    questions: judged.map((q) => ({
      ...asked(q),
      verdict: q.verdict,
      right: q.right,
      wrong: q.wrong,
    })),
  };
  const parts = [
    `${t.answered} of ${t.asked} answered in place, ${t.misplaced} misplaced, ${t.unanswered} unanswered`,
  ];
  if (t.answered === 0 && t.misplaced === 0)
    parts.push("the agent did not answer a member's mention");
  if (stopped)
    parts.push(
      `stopped after ${t.asked} of ${plan.length} mentions, as the bar could no longer be met`,
    );
  const pass = t.misplaced === 0 && t.unanswered <= MAX_UNANSWERED && t.asked === MENTIONS;
  return {
    result: pass ? "pass" : "fail",
    reason:
      parts.join("; ") + (pass ? "" : ` (bar: 0 misplaced, at most ${MAX_UNANSWERED} unanswered)`),
    evidence,
  };
}

/** Rule 5, three runs. */
export async function rightPlace(ctx) {
  const missing = rightPlaceLacks(ctx);
  if (missing) return { result: "not checked", reason: missing };
  return repeated(ctx, once);
}

/** Unscored: one burst each of 1, 3, 10 and 30 mentions over the same places, and how placement held. */
export async function burstSizes(ctx) {
  const missing = rightPlaceLacks(ctx);
  if (missing) return { reason: missing };
  const where = await places(ctx);
  const out = [];
  for (const size of [1, 3, 10, 30]) {
    const values = drawValues(size);
    const plan = values.map((value, i) => ({ value, place: where[(i * 7) % where.length] }));
    const since = await ctx.slack.seq();
    const { questions, bursts } = await inBursts(ctx, plan, size, since);
    const t = tally(judge(questions, await ctx.slack.posts({ team: ctx.team, since })));
    out.push({
      size,
      ...t,
      seconds: bursts[0]?.seconds,
      waitedForLimitMs: bursts[0]?.waitedForLimitMs,
    });
  }
  return { sizes: out };
}
