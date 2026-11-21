// The smoke check, outside the score: a direct message gets a reply. It reads
// nothing of what the reply says. A Concierge that does not answer shows here
// and in no rule.

import { ask, code } from "../lib/codes.mjs";
import { sleep } from "../lib/http.mjs";
import { allOnce, replyAfter, summary, tally } from "../lib/replies.mjs";

export async function smoke(ctx) {
  if (!ctx.bound.a) return { result: "not checked", reason: "R1 made no connection to build on." };
  const ws = ctx.wsA;
  const tag = code("SMOKE", 0);
  const since = await ctx.slack.seq();
  const sent = await ctx.slack.dm(ws.id, ws.guardian, ask(tag));
  await replyAfter(ctx.slack, { team: ws.id, channel: sent.channel, since, timeoutMs: ctx.env.timeouts.replySeconds * 1000 });
  await sleep(ctx.env.timeouts.settleSeconds * 1000);
  const t = tally(await ctx.slack.posts({ team: ws.id, since }), { channel: sent.channel, sent: [{ tag, since }] });
  const evidence = { eventId: sent.eventId, channel: sent.channel, ...t };
  return allOnce(t)
    ? { result: "pass", reason: "A direct message got exactly one reply.", evidence }
    : { result: "fail", reason: summary(t), evidence };
}
