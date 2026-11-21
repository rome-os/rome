// Draft, not scored (planner, 2026-11-21): the wording proposed to Ouou in
// place of R13 is "Rome's Slack app keeps no record of its own, and a
// message Slack delivers twice is recorded and answered once". It runs only
// with VERIFIER_DRAFTS=dedup, after R13, until the wording is confirmed.
//
// The same direct message reaches Rome twice more after its first delivery:
// once while the instance runs and once after a restart of it. Each second
// delivery is Slack's own retry of the same event (same event_id) when the
// environment can send one (POST /_control/redeliver), else the same message
// (channel, ts, client_msg_id) under a new event_id (POST /_control/event).
// Passing: exactly one reply in the direct message in all, and Chats holds
// the message once.

import { ask, code } from "../lib/codes.mjs";
import { phase, sleep, waitFor } from "../lib/http.mjs";
import { replyAfter } from "../lib/replies.mjs";

export async function dedup(ctx) {
  if (!ctx.bound.a) return { result: "not checked", reason: "R1 made no connection to build on." };
  const ws = ctx.wsA;
  const evidence = { deliveries: [] };
  const tag = code("RDUP", 1);
  const start = await ctx.slack.seq();

  phase("dedup: first delivery");
  const sent = await ctx.slack.dm(ws.id, ws.guardian, ask(tag));
  const dm = sent.channel;
  await replyAfter(ctx.slack, { team: ws.id, channel: dm, since: start, timeoutMs: ctx.env.timeouts.replySeconds * 1000 });
  await sleep(ctx.env.timeouts.settleSeconds * 1000);
  const original = (await ctx.slack.events(start)).find((e) => e.eventId === sent.eventId)?.body?.event;
  evidence.first = { eventId: sent.eventId, ts: sent.ts, replies: await repliesIn(ctx, ws, dm, start) };
  if (evidence.first.replies !== 1)
    return { result: "not checked", reason: `the first delivery got ${evidence.first.replies} replies, so a second one cannot be judged`, evidence };

  // Again, while the instance runs; then again after a restart.
  const again = async (when) => {
    const before = await ctx.slack.seq();
    let how;
    let r = await ctx.slack.redeliver(sent.eventId);
    if (r) how = "same event_id (Slack's retry)";
    else if (original) {
      r = await ctx.slack.event(ws.id, original);
      how = "same message, new event_id";
    } else return { when, how: "none: the fake gave neither a redelivery nor the event's body" };
    await sleep((ctx.env.timeouts.replySeconds + ctx.env.timeouts.settleSeconds) * 1000);
    const d = { when, how, eventId: r.event_id ?? sent.eventId, delivery: r.delivery?.status ?? null, newReplies: await repliesIn(ctx, ws, dm, before) };
    evidence.deliveries.push(d);
    return d;
  };
  phase("dedup: second delivery, running");
  await again("while running");

  // A repeat while the first delivery's turn is still running: a second
  // message, repeated at once, before any reply to it. If its reply was
  // already posted when the repeat went out, the fake could not time it.
  phase("dedup: repeat during the turn");
  {
    const tag2 = code("RDUP", 2);
    const before = await ctx.slack.seq();
    const s2 = await ctx.slack.dm(ws.id, ws.guardian, ask(tag2));
    const body2 = (await ctx.slack.events(before)).find((e) => e.eventId === s2.eventId)?.body?.event;
    let r = await ctx.slack.redeliver(s2.eventId);
    let how = "same event_id (Slack's retry)";
    if (!r && body2) {
      r = await ctx.slack.event(ws.id, body2);
      how = "same message, new event_id";
    }
    const repliedBeforeRepeat = await repliesIn(ctx, ws, dm, before);
    await replyAfter(ctx.slack, { team: ws.id, channel: dm, since: before, timeoutMs: ctx.env.timeouts.replySeconds * 1000 });
    await sleep((ctx.env.timeouts.replySeconds + ctx.env.timeouts.settleSeconds) * 1000);
    const replies = await repliesIn(ctx, ws, dm, before);
    let recorded2 = null;
    try {
      recorded2 = (await ctx.a.recordedIn(dm, { connection: ctx.bound.a })).filter((m) => String(m).includes(tag2)).length;
    } catch {}
    evidence.duringTurn = { how: r ? how : "none", repliedBeforeRepeat, replies, recordedInChats: recorded2 };
  }
  phase("dedup: restart");
  await ctx.a.stop();
  await ctx.a.start();
  await waitFor(() => ctx.a.up(), { timeoutMs: ctx.env.timeouts.restartSeconds * 1000, everyMs: 2000 });
  await sleep(ctx.env.timeouts.settleSeconds * 1000);
  phase("dedup: third delivery, after a restart");
  await again("after a restart");

  // Chats holds it once: the inbound entries of the direct message's chat
  // that carry the tag.
  phase("dedup: read Chats");
  let recorded = null;
  try {
    recorded = (await ctx.a.recordedIn(dm, { connection: ctx.bound.a })).filter((m) => String(m).includes(tag)).length;
  } catch (err) {
    evidence.recordedError = err.message;
  }
  evidence.recordedInChats = recorded;
  // Replies to the first message only: those after it and before the second.
  const total = evidence.first.replies + evidence.deliveries.reduce((n, d) => n + (d.newReplies ?? 0), 0);
  evidence.repliesInAll = total;

  const tried = evidence.deliveries.filter((d) => d.eventId);
  const dt = evidence.duringTurn;
  const duringTurn =
    !dt || dt.how === "none"
      ? { result: "not checked", why: "the repeat could not be sent" }
      : dt.repliedBeforeRepeat > 0
        ? { result: "not checked", why: "the reply came before the repeat went out, so the fake could not time it during the turn" }
        : dt.replies === 1 && (dt.recordedInChats === null || dt.recordedInChats === 1)
          ? { result: "pass", why: `repeated during the turn (${dt.how}): 1 reply, Chats holds it ${dt.recordedInChats ?? "?"} time(s)` }
          : { result: "fail", why: `repeated during the turn (${dt.how}): ${dt.replies} replies, Chats holds it ${dt.recordedInChats ?? "?"} time(s)` };
  evidence.duringTurnVerdict = duringTurn;
  const said = `during the turn: ${duringTurn.result} (${duringTurn.why}); ${tried.length + 1} deliveries (${tried.map((d) => `${d.when}: ${d.how}`).join("; ") || "no repeat sent"}); ${total} repl${total === 1 ? "y" : "ies"} in the direct message; Chats holds the message ${recorded ?? "?"} time(s)`;
  if (tried.length < 2) return { result: "not checked", reason: `${said}; not every repeat could be sent`, evidence };
  const problems = [];
  if (total !== 1) problems.push(`${total} replies, not 1`);
  if (duringTurn.result === "fail") problems.push(`a repeat during the turn: ${duringTurn.why}`);
  if (recorded !== null && recorded !== 1) problems.push(`Chats holds it ${recorded} times, not once`);
  if (problems.length) return { result: "fail", reason: `${problems.join("; ")}. ${said}`, evidence };
  if (recorded === null) return { result: "not checked", reason: `${said}; Chats could not be read: ${evidence.recordedError}`, evidence };
  return { result: "pass", reason: said, evidence };
}

/** The app's posts in `dm` after `since`. */
async function repliesIn(ctx, ws, dm, since) {
  return (await ctx.slack.posts({ team: ws.id, channel: dm, since })).filter((p) => p.tokenKind === "bot").length;
}
