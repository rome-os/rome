// R4 (direct messages work), R6 (nothing lost while offline) and R7 (nothing
// forged or misrouted arrives).

import { ask, code } from "../lib/codes.mjs";
import { sleep, waitFor } from "../lib/http.mjs";
import { awaitReplies, tally } from "../lib/replies.mjs";
import { oneReply } from "./connect.mjs";

const summary = (t) =>
  `${t.answeredOnce} of ${t.sent} answered exactly once` +
  (t.unanswered.length ? `; ${t.unanswered.length} unanswered` : "") +
  (t.answeredMoreThanOnce.length
    ? `; ${t.answeredMoreThanOnce.length} answered more than once`
    : "") +
  (t.repliesWithNoCode.length ? `; ${t.repliesWithNoCode.length} replies matched no message` : "");

const allOnce = (t) => t.answeredOnce === t.sent && t.repliesWithNoCode.length === 0;

export async function r4(ctx) {
  if (!ctx.bound.a) return { result: "not checked", reason: "R1 made no connection to build on." };
  const ws = ctx.wsA;
  const since = await ctx.slack.seq();
  const codes = [];
  const eventIds = [];
  let channel;
  for (let i = 1; i <= 20; i++) {
    const c = code("R4", i);
    const sent = await ctx.slack.dm(ws.id, ws.guardian, ask(c));
    channel = sent.channel;
    codes.push(c);
    eventIds.push(sent.eventId);
    // One message at a time, as a person would write: wait for its reply.
    await waitFor(
      async () =>
        (await ctx.slack.posts({ team: ws.id, channel, since })).some((p) => p.text?.includes(c)),
      { timeoutMs: ctx.env.timeouts.replySeconds * 1000 },
    );
  }
  const t = tally(
    await awaitReplies(ctx.slack, {
      team: ws.id,
      channel,
      since,
      codes,
      timeoutMs: 0,
      settleMs: ctx.env.timeouts.settleSeconds * 1000,
    }),
  );
  ctx.fromA = { codes, eventIds, since };
  const evidence = { workspace: ws.id, channel, eventIds, ...t };
  return allOnce(t)
    ? {
        result: "pass",
        reason: "20 of 20 direct messages got exactly one reply in the same direct message.",
        evidence,
      }
    : { result: "fail", reason: summary(t), evidence };
}

export async function r7(ctx) {
  if (!ctx.bound.a) return { result: "not checked", reason: "R1 made no connection to build on." };
  const ws = ctx.wsA;
  const evidence = {};
  const problems = [];
  let partial = null;
  const readable = async (read) => {
    try {
      return await read();
    } catch (err) {
      partial ??= `a read of what Rome recorded failed: ${err.message}`;
      return null;
    }
  };

  // Forged: 10 events with a bad signature, then one good message. Its reply
  // shows the path was open while the forged ones went by.
  const since = await ctx.slack.seq();
  const forged = [];
  let channel;
  for (let i = 1; i <= 10; i++) {
    const c = code("R7F", i);
    const sent = await ctx.slack.forged(ws.id, ws.guardian, ask(c));
    channel = sent.channel;
    forged.push({ code: c, eventId: sent.eventId, status: sent.delivery?.status ?? null });
  }
  const control = await oneReply(ctx, ws, "R7C");
  const posts = await ctx.slack.posts({ team: ws.id, channel, since });
  const replied = forged.filter((f) => posts.some((p) => p.text?.includes(f.code)));
  const recorded = await readable(() => ctx.a.recordedFrom(ws.id, ws.guardian));
  const recordedForged = recorded && forged.filter((f) => recorded.some((b) => b.includes(f.code)));
  evidence.forged = {
    sent: forged.map((f) => f.eventId),
    deliveryStatuses: forged.map((f) => f.status),
    replied: replied.map((f) => f.eventId),
    recorded: recordedForged?.map((f) => f.eventId) ?? "not readable",
    goodMessageAfter: { eventId: control.eventId, replies: control.replies },
  };
  if (!control.ok)
    problems.push("the good message after the forged ones did not get exactly one reply");
  if (replied.length) problems.push(`${replied.length} of 10 forged events got a reply`);
  if (recordedForged?.length)
    problems.push(`${recordedForged.length} of 10 forged events were recorded`);

  // Misrouted: R4's 20 messages came from workspace A. None may reach the
  // instance bound to workspace B: no Slack call from it about them, no
  // account of workspace A observed there, and nothing recorded from A's guardian.
  if (!ctx.bound.b || !ctx.fromA) {
    evidence.misrouted = "not checked: the second instance has no connection, or R4 did not run";
    partial ??= "the misrouting half had nothing to check";
  } else {
    const callsByB = await ctx.slack.calls({ team: ctx.wsB.id, since: ctx.fromA.since });
    const aboutA = callsByB.filter((c) =>
      ctx.fromA.codes.some((k) => JSON.stringify(c.args ?? {}).includes(k)),
    );
    const accountsB = await readable(() => ctx.b.slackAccounts());
    const fromAOnB = accountsB?.filter((id) => id.startsWith(`${ws.id}/`));
    const recordedB = await readable(() => ctx.b.recordedFrom(ws.id, ws.guardian));
    const reachedB =
      recordedB && ctx.fromA.codes.filter((k) => recordedB.some((b) => b.includes(k)));
    evidence.misrouted = {
      fromWorkspace: ws.id,
      events: ctx.fromA.eventIds,
      slackCallsBySecondInstanceAboutThem: aboutA.length,
      accountsOfWorkspaceAOnSecond: fromAOnB ?? "not readable",
      recordedBySecondInstance: reachedB?.length ?? "not readable",
    };
    if (aboutA.length)
      problems.push(
        `the instance bound to ${ctx.wsB.id} made ${aboutA.length} Slack calls about ${ws.id}'s messages`,
      );
    if (fromAOnB?.length)
      problems.push(
        `the instance bound to ${ctx.wsB.id} observed ${fromAOnB.length} account(s) of ${ws.id}`,
      );
    if (reachedB?.length)
      problems.push(
        `${reachedB.length} of 20 events from ${ws.id} reached the instance bound to ${ctx.wsB.id}`,
      );
  }

  if (problems.length) return { result: "fail", reason: problems.join("; "), evidence };
  if (partial)
    return { result: "not checked", reason: `No failure seen, but ${partial}.`, evidence };
  return {
    result: "pass",
    reason:
      "10 of 10 forged events dropped with no reply or record; 0 of 20 events from workspace A reached the instance bound to B.",
    evidence,
  };
}

export async function r6(ctx) {
  if (!ctx.bound.a) return { result: "not checked", reason: "R1 made no connection to build on." };
  const ws = ctx.wsA;
  const env = ctx.env;
  await ctx.a.stop();
  const down = await waitFor(async () => !(await ctx.a.up()), { timeoutMs: 60_000 });
  if (!down) return { result: "fail", reason: "The instance still answered a minute after stop." };
  const stoppedAt = Date.now();

  const since = await ctx.slack.seq();
  const codes = [];
  const eventIds = [];
  let channel;
  for (let i = 1; i <= 20; i++) {
    const c = code("R6", i);
    const sent = await ctx.slack.dm(ws.id, ws.guardian, ask(c));
    channel = sent.channel;
    codes.push(c);
    eventIds.push(sent.eventId);
  }
  await sleep(Math.max(0, env.stopSeconds * 1000 - (Date.now() - stoppedAt)));
  const whileStopped = (await ctx.slack.posts({ team: ws.id, channel, since })).length;

  await ctx.a.start();
  const up = await waitFor(() => ctx.a.up(), { timeoutMs: env.timeouts.restartSeconds * 1000 });
  const evidence = {
    workspace: ws.id,
    channel,
    stopSeconds: env.stopSeconds,
    eventIds,
    repliesWhileStopped: whileStopped,
  };
  if (!up)
    return { result: "fail", reason: "The instance did not come back after start.", evidence };

  const t = tally(
    await awaitReplies(ctx.slack, {
      team: ws.id,
      channel,
      since,
      codes,
      timeoutMs: env.timeouts.replySeconds * 1000 * 5,
      settleMs: env.timeouts.settleSeconds * 1000,
    }),
  );
  Object.assign(evidence, t);
  if (whileStopped)
    return {
      result: "fail",
      reason: `${whileStopped} replies came while the instance was stopped`,
      evidence,
    };
  return allOnce(t)
    ? {
        result: "pass",
        reason: `20 of 20 messages sent during a ${env.stopSeconds}s stop were answered exactly once after restart.`,
        evidence,
      }
    : { result: "fail", reason: summary(t), evidence };
}
