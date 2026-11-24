// Rule 6: two members ask the same question at the same moment in two chats,
// and each chat's own fact gives a different answer. 20 pairs a run.

import { lacks, pace, repeated } from "../lib/pace.mjs";
import { asked, awaitValues, judge } from "../lib/places.mjs";
import { drawFacts, drawValues, factText, fillers, questionText } from "../lib/scenario.mjs";

const PAIRS = 20;

/** Every two chats that have a different member, not the guardian, to ask in each. */
function chatPairs(chats) {
  const out = [];
  for (let i = 0; i < chats.length; i++)
    for (let j = i + 1; j < chats.length; j++) {
      const a = chats[i].people[0];
      const b = chats[j].people.find((p) => p !== a);
      if (a && b) out.push([chats[i], chats[j]]);
    }
  return out;
}

export function rightPersonLacks(ctx) {
  return lacks(
    "pair(s) of shared chats with a different member, not the guardian, in each",
    chatPairs(ctx.chats).length,
    1,
  );
}

async function once(ctx, run) {
  const pairs = chatPairs(ctx.chats.slice(0, 5));
  const topics = drawFacts(PAIRS, { exclude: ctx.usedTopics, qualified: true });
  ctx.usedTopics.push(...topics.map((t) => t.topic));
  const rounds = [];
  for (let i = 0; i < PAIRS; i++) {
    const [c1, c2] = pairs[(i + run) % pairs.length];
    const a1 = c1.people[i % c1.people.length];
    const a2 =
      c2.people.find((p) => p !== a1 && c2.people.indexOf(p) >= i % c2.people.length) ??
      c2.people.find((p) => p !== a1);
    const [v1, v2] = drawValues(2);
    const topic = topics[i].topic;
    // Someone other than the asker writes each chat's fact, then one more message.
    const writer = (c, asker) => c.people.find((p) => p !== asker) ?? asker;
    const [filler1, filler2] = fillers(2);
    await ctx.slack.groupMessage(
      ctx.team,
      writer(c1, a1),
      c1.id,
      factText({ topic, value: v1.value }, i),
    );
    await ctx.slack.groupMessage(
      ctx.team,
      writer(c2, a2),
      c2.id,
      factText({ topic, value: v2.value }, i + 1),
    );
    await ctx.slack.groupMessage(ctx.team, a1, c1.id, filler1);
    await ctx.slack.groupMessage(ctx.team, a2, c2.id, filler2);
    const waited = await pace(ctx);
    const since = await ctx.slack.seq();
    const question = questionText({ topic }, i);
    const t0 = Date.now();
    const [m1, m2] = await ctx.slack.batch(ctx.team, [
      { kind: "mention", user: a1, channel: c1.id, text: question },
      { kind: "mention", user: a2, channel: c2.id, text: question },
    ]);
    const qs = [
      { channel: c1.id, threadTs: null, ts: m1.ts, by: a1, value: v1 },
      { channel: c2.id, threadTs: null, ts: m2.ts, by: a2, value: v2 },
    ];
    const posts = await awaitValues(
      ctx,
      qs,
      since,
      ctx.replyMs + 2 * ctx.env.historyLimit.windowMs,
    );
    const judged = judge(qs, posts);
    const repliesIn = (q) =>
      posts
        .filter((p) => p.channel === q.channel)
        .map((p) => ({ channel: p.channel, threadTs: p.threadTs ?? null, ts: p.ts, text: p.text }));
    const ok = judged.every((q) => q.verdict === "answered");
    const round = {
      pair: i + 1,
      waitedForLimitMs: waited,
      seconds: Math.round((Date.now() - t0) / 1000),
      ok,
      asks: judged.map((q) => ({
        ...asked(q),
        verdict: q.verdict,
        right: q.right,
        wrong: q.wrong,
        replies: repliesIn(q),
      })),
    };
    rounds.push(round);
    ctx.log(
      `    pair ${i + 1}: ${judged.map((q) => q.verdict).join(" / ")}, waited ${Math.round(waited / 1000)} s for the limit`,
    );
    if (!ok) break;
  }
  const good = rounds.filter((r) => r.ok).length;
  const evidence = { pairs: rounds };
  if (good === PAIRS)
    return {
      result: "pass",
      reason: `${PAIRS} of ${PAIRS} pairs: each member got their own chat's answer`,
      evidence,
    };
  const last = rounds.at(-1);
  const why = last.asks
    .map((q) =>
      q.verdict === "unanswered"
        ? q.replies.length
          ? "answered without its chat's value"
          : "did not answer a member's mention"
        : q.verdict === "misplaced"
          ? "its chat's value also appeared in the other chat"
          : "own answer",
    )
    .join(" / ");
  return {
    result: "fail",
    reason: `pair ${last.pair} failed (${why}); ${good} pair(s) passed before it, ${PAIRS - rounds.length} not asked (bar: ${PAIRS} of ${PAIRS})`,
    evidence,
  };
}

/** Rule 6, three runs. */
export async function rightPerson(ctx) {
  const missing = rightPersonLacks(ctx);
  if (missing) return { result: "not checked", reason: missing };
  return repeated(ctx, once);
}
