// Rule 2: 50 messages that never mention the agent, of mixed kinds; the app
// must post nothing in that chat.

import { randomInt } from "node:crypto";
import { silenceMessages } from "../lib/scenario.mjs";

/** Writes the 50 messages, waits `ctx.settleMs`, and counts the app's posts in the chat since the first. */
export async function silence(ctx) {
  const kinds = silenceMessages();
  const m = ctx.members;
  const first = await ctx.slack.seq();
  const started = new Date().toISOString();
  const sent = [];
  let eventsSent = 0;
  const say = async (kind, text, threadTs) => {
    const by = m[sent.length % m.length];
    const r = await ctx.slack.groupMessage(ctx.team, by, ctx.channel, text, threadTs);
    if (r.eventSent) eventsSent += 1;
    sent.push({ kind, ts: r.ts, by, ...(threadTs ? { threadTs } : {}) });
    await ctx.sleep(ctx.messageGapMs);
    return r.ts;
  };
  // Two plain messages open the threads the replies go into.
  const parents = [await say("plain", kinds.plain[0]), await say("plain", kinds.plain[1])];
  const rest = [
    ...kinds.plain.slice(2).map((text) => ["plain", text]),
    ...kinds.question.map((text) => ["question", text]),
    ...kinds.name.map((text) => ["name", text]),
    ...kinds.thread.map((text) => ["thread", text]),
  ];
  for (let i = rest.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [rest[i], rest[j]] = [rest[j], rest[i]];
  }
  let replies = 0;
  for (const [kind, text] of rest) {
    if (kind === "thread") await say(kind, text, parents[replies++ % parents.length]);
    else await say(kind, text);
  }
  ctx.log(
    `  wrote ${sent.length} messages; waiting ${Math.round(ctx.settleMs / 1000)} s for any post`,
  );
  await ctx.sleep(ctx.settleMs);
  const posts = await ctx.slack.posts({ team: ctx.team, since: first });
  const calls = await ctx.slack.calls({ team: ctx.team, since: first });
  const inChat = posts.filter((p) => p.channel === ctx.channel);
  const byKind = Object.fromEntries(
    ["plain", "question", "thread", "name"].map((k) => [
      k,
      sent.filter((s) => s.kind === k).length,
    ]),
  );
  const evidence = {
    messages: sent.length,
    byKind,
    groupMessageEventsSent: eventsSent,
    from: started,
    settleSeconds: Math.round(ctx.settleMs / 1000),
    postsInChat: inChat.map((p) => ({ ts: p.ts, threadTs: p.threadTs ?? null, text: p.text })),
    postsElsewhere: posts
      .filter((p) => p.channel !== ctx.channel)
      .map((p) => ({ channel: p.channel, ts: p.ts, text: p.text })),
    // Reported, not scored.
    webApiCalls: calls.map((c) => ({
      at: c.at,
      method: c.method,
      ok: c.ok,
      error: c.error ?? null,
    })),
  };
  if (inChat.length === 0)
    return {
      result: "pass",
      reason: `0 posts in the chat across ${sent.length} unmentioned messages`,
      evidence,
    };
  return {
    result: "fail",
    reason: `${inChat.length} post(s) in the chat across ${sent.length} unmentioned messages (bar 0)`,
    evidence,
  };
}
