// Counts the bot's replies to seeded messages by where and when the fake Slack
// recorded them: a reply belongs to the last message sent before it in the
// same chat. Messages are sent one at a time, each after the previous one's
// reply, so that order is sound.

import { waitFor } from "./http.mjs";

/** Waits up to `timeoutMs` for any post in `channel` after `since`. True if one came. */
export async function replyAfter(slack, { team, channel, since, timeoutMs }) {
  return Boolean(
    await waitFor(async () => (await slack.posts({ team, channel, since })).length > 0, {
      timeoutMs,
    }),
  );
}

const brief = (p) => ({ channel: p.channel, seq: p.seq, text: p.text?.slice(0, 120) });

/**
 * Counts `posts` (every post in the workspace after the first message) against
 * `sent`, the messages in send order, each `{tag, since}` with the seq read
 * just before it was sent. A post in `channel` counts for the last message
 * whose `since` it follows. Posts anywhere else are listed apart.
 */
export function tally(posts, { channel, sent }) {
  const inChat = posts.filter((p) => p.channel === channel);
  const counts = sent.map((m, i) => {
    const next = sent[i + 1]?.since ?? Number.POSITIVE_INFINITY;
    return {
      tag: m.tag,
      replies: inChat.filter((p) => p.seq > m.since && p.seq <= next).length,
    };
  });
  return {
    sent: sent.length,
    answeredOnce: counts.filter((c) => c.replies === 1).length,
    unanswered: counts.filter((c) => c.replies === 0).map((c) => c.tag),
    answeredMoreThanOnce: counts.filter((c) => c.replies > 1).map((c) => c.tag),
    repliesInChat: inChat.length,
    postsElsewhere: posts.filter((p) => p.channel !== channel).map(brief),
    perMessage: counts,
  };
}

/** True when every message got exactly one reply and nothing went elsewhere. */
export const allOnce = (t) =>
  t.answeredOnce === t.sent && t.repliesInChat === t.sent && t.postsElsewhere.length === 0;

/** The counts in words: what was posted, and how it matched the messages. */
export const summary = (t) =>
  `${t.sent} message(s): ${t.answeredOnce} got exactly one reply` +
  (t.answeredMoreThanOnce.length ? `, ${t.answeredMoreThanOnce.length} got more than one` : "") +
  (t.unanswered.length ? `, ${t.unanswered.length} got none` : "") +
  `; ${t.repliesInChat} repl${t.repliesInChat === 1 ? "y" : "ies"} posted in the direct message` +
  (t.postsElsewhere.length ? `; ${t.postsElsewhere.length} posted in other conversations` : "");
