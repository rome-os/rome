// Where an answer landed. A question is asked in a place: a chat, a thread in
// a chat, or a member's direct message. Its answer holds a value found in no
// other question, so each post that holds the value is in the right place or
// in a wrong one.

import { holdsValue } from "./scenario.mjs";

/**
 * Whether `post` is in the place `q` asked in. A thread's question is
 * answered in that thread. A question in the open chat is answered in the
 * open chat or in a thread on the question itself, as Slack apps often
 * reply. A direct message is answered anywhere in that direct message.
 */
export function inPlace(q, post) {
  if (post.channel !== q.channel) return false;
  if (q.dm) return true;
  const thread = post.threadTs ?? null;
  if (q.threadTs) return thread === q.threadTs;
  return thread === null || thread === q.ts;
}

/** A post's place as the report names it. */
export const placeOfPost = (post) => ({
  channel: post.channel,
  threadTs: post.threadTs ?? null,
  ts: post.ts,
});

/**
 * Judges each question against every post: `right` holds the posts with its
 * value in its place, `wrong` those elsewhere. The verdict is `misplaced`
 * when any post elsewhere holds the value, else `answered` or `unanswered`.
 */
export function judge(questions, posts) {
  return questions.map((q) => {
    const holding = posts.filter((p) => holdsValue(p.text, q.value));
    const right = holding.filter((p) => inPlace(q, p));
    const wrong = holding.filter((p) => !inPlace(q, p));
    const verdict = wrong.length ? "misplaced" : right.length ? "answered" : "unanswered";
    return { ...q, verdict, right: right.map(placeOfPost), wrong: wrong.map(placeOfPost) };
  });
}

/**
 * Waits until every question has a post holding its value (anywhere), or
 * `deadlineMs` passes; then `ctx.afterReplyMs` more for any stray post.
 * Returns every post in the workspace since `since`.
 */
export async function awaitValues(ctx, questions, since, deadlineMs) {
  const deadline = Date.now() + deadlineMs;
  for (;;) {
    const posts = await ctx.slack.posts({ team: ctx.team, since });
    const open = questions.filter((q) => !posts.some((p) => holdsValue(p.text, q.value)));
    if (!open.length || Date.now() >= deadline) break;
    await ctx.sleep(1000);
  }
  await ctx.sleep(ctx.afterReplyMs);
  return ctx.slack.posts({ team: ctx.team, since });
}

/** Counts of each verdict in `judged`. */
export function tally(judged) {
  const count = (v) => judged.filter((q) => q.verdict === v).length;
  return {
    asked: judged.length,
    answered: count("answered"),
    misplaced: count("misplaced"),
    unanswered: count("unanswered"),
  };
}

/** The question as the report keeps it: where it was asked, by whom, and the value. */
export function asked(q) {
  return {
    channel: q.channel,
    threadTs: q.threadTs ?? null,
    ts: q.ts,
    by: q.by,
    dm: q.dm === true,
    value: q.value.value,
  };
}
