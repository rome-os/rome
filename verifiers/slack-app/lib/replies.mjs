// Waits for the bot's replies to seeded messages and matches them by code.

import { match } from "./codes.mjs";
import { sleep, waitFor } from "./http.mjs";

/**
 * Waits until every one of `codes` has a reply in `channel`, or until
 * `timeoutMs` passes, then waits `settleMs` more so a second reply to any of
 * them has time to arrive. Returns the match over every post in the workspace
 * after `since`, and the posts that went anywhere but `channel`.
 */
export async function awaitReplies(slack, { team, channel, since, codes, timeoutMs, settleMs }) {
  await waitFor(
    async () => {
      const { counts } = match(await slack.posts({ team, since }), codes);
      return codes.every((c) => counts[c] > 0);
    },
    { timeoutMs },
  );
  await sleep(settleMs);
  const posts = await slack.posts({ team, since });
  const elsewhere = posts
    .filter((p) => p.channel !== channel)
    .map((p) => ({ channel: p.channel, ts: p.ts, text: p.text?.slice(0, 120) }));
  return { posts: posts.length, elsewhere, ...match(posts, codes) };
}

/** Sums up a match: how many codes got 0, 1 and more than 1 reply. */
export function tally({ counts, unmatched, posts, elsewhere }) {
  const values = Object.values(counts);
  return {
    sent: values.length,
    answeredOnce: values.filter((n) => n === 1).length,
    unanswered: Object.keys(counts).filter((c) => counts[c] === 0),
    answeredMoreThanOnce: Object.keys(counts).filter((c) => counts[c] > 1),
    repliesWithNoCode: unmatched,
    replies: posts,
    postsElsewhere: elsewhere,
  };
}
