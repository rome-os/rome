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
  (t.repliesWithNoCode.length ? `; ${t.repliesWithNoCode.length} replies matched no message` : "") +
  (t.postsElsewhere.length
    ? `; ${t.postsElsewhere.length} posts went to another conversation`
    : "");

const allOnce = (t) =>
  t.answeredOnce === t.sent && t.repliesWithNoCode.length === 0 && t.postsElsewhere.length === 0;

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
  ctx.fromA = { codes, eventIds, since, channel };
  const evidence = { workspace: ws.id, channel, eventIds, ...t };
  return allOnce(t)
    ? {
        result: "pass",
        reason: "20 of 20 direct messages got exactly one reply in the same direct message.",
        evidence,
      }
    : { result: "fail", reason: summary(t), evidence };
}

/** A delivery Rome Cloud itself answered: any status but none or a 5xx. */
const conclusive = (status) => Boolean(status) && status < 500;

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
  for (let i = 1; i <= 10; i++) {
    const c = code("R7F", i);
    // A forged event Rome Cloud never answered, or answered only through a
    // gateway error (5xx), tests nothing: the fake Slack does not retry
    // forgeries, so send it again, up to three times.
    const tries = [];
    for (let t = 0; t < 3; t++) {
      const sent = await ctx.slack.forged(ws.id, ws.guardian, ask(c));
      tries.push({ eventId: sent.eventId, status: sent.delivery?.status ?? null });
      if (conclusive(tries.at(-1).status)) break;
    }
    forged.push({ code: c, eventId: tries.at(-1).eventId, tries, status: tries.at(-1).status });
  }
  const undelivered = forged.filter((f) => !conclusive(f.status));
  if (undelivered.length)
    partial ??= `${undelivered.length} of 10 forged events got no answer or only a 5xx after 3 tries, so the signature check was not exercised`;
  const control = await oneReply(ctx, ws, "R7C");
  // Every post in the workspace since before the forged events, wherever it
  // went: a reply to a forged event in another conversation still answers it.
  const posts = await ctx.slack.posts({ team: ws.id, since });
  const replied = forged.filter((f) => posts.some((p) => p.text?.includes(f.code)));
  // Only the good message's one reply may follow the forged events. A reply
  // that repeats no code still answers one of them.
  const others = posts.filter((p) => !p.text?.includes(code("R7C", 0)));
  // The bot chat's own session: the People timeline leaves agent chats out.
  const recorded = control.channel ? await readable(() => ctx.a.recordedIn(control.channel)) : null;
  // The good message must show in the same read, or an empty read proves
  // nothing about the forged ones.
  const sawGood = recorded?.some((b) => b.includes(code("R7C", 0)));
  if (recorded && !sawGood)
    partial ??=
      "the read of what Rome recorded does not show the good message, so it cannot show the forged ones are absent";
  const recordedForged = recorded && forged.filter((f) => recorded.some((b) => b.includes(f.code)));
  evidence.forged = {
    sent: forged.flatMap((f) => f.tries.map((t) => t.eventId)),
    deliveryStatuses: forged.map((f) => f.tries.map((t) => t.status)),
    replied: replied.map((f) => f.eventId),
    otherPosts: others.map((p) => ({ channel: p.channel, ts: p.ts, text: p.text?.slice(0, 120) })),
    recorded: recordedForged?.map((f) => f.eventId) ?? "not readable",
    goodMessageVisibleInRecord: Boolean(sawGood),
    goodMessageAfter: { eventId: control.eventId, replies: control.replies },
  };
  if (!control.ok)
    problems.push("the good message after the forged ones did not get exactly one reply");
  if (replied.length) problems.push(`${replied.length} of 10 forged events got a reply`);
  else if (others.length)
    problems.push(
      `${others.length} posts besides the good message's reply followed the forged events`,
    );
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
    // A call is about workspace A's messages when it names one of their codes,
    // A's team, A's guardian or the direct message they came in, whatever the
    // method: a lookup with nothing posted still means the event reached B.
    const marks = [...ctx.fromA.codes, ws.id, ws.guardian, ctx.fromA.channel].filter(Boolean);
    const aboutA = callsByB.filter((c) => {
      const args = JSON.stringify(c.args ?? {});
      return marks.some((k) => args.includes(k));
    });
    // B's workspace was quiet the whole time: a post there means one of A's
    // events reached B, even if the post names nothing of A.
    const postsInB = await ctx.slack.posts({ team: ctx.wsB.id, since: ctx.fromA.since });
    const accountsB = await readable(() => ctx.b.slackAccounts());
    const fromAOnB = accountsB?.filter((id) => id.startsWith(`${ws.id}/`));
    // B has no session for A's direct message unless an event of A reached it.
    const recordedB = await readable(() =>
      ctx.b.recordedIn(ctx.fromA.channel, { noneIfMissing: true }),
    );
    const reachedB =
      recordedB && ctx.fromA.codes.filter((k) => recordedB.some((b) => b.includes(k)));
    evidence.misrouted = {
      fromWorkspace: ws.id,
      events: ctx.fromA.eventIds,
      slackCallsBySecondInstanceAboutThem: aboutA.map((c) => c.method),
      postsInSecondWorkspace: postsInB.map((p) => ({
        channel: p.channel,
        text: p.text?.slice(0, 120),
      })),
      accountsOfWorkspaceAOnSecond: fromAOnB ?? "not readable",
      recordedBySecondInstance: reachedB?.length ?? "not readable",
    };
    if (aboutA.length)
      problems.push(
        `the instance bound to ${ctx.wsB.id} made ${aboutA.length} Slack calls about ${ws.id}'s messages`,
      );
    if (postsInB.length)
      problems.push(
        `${postsInB.length} posts appeared in ${ctx.wsB.id} while only ${ws.id} was sent messages`,
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
  const since = await ctx.slack.seq();
  const codes = [];
  const eventIds = [];
  let channel;
  let whileStopped;
  // Whatever fails while the instance is down, start it again, so a crash
  // here leaves the environment as it found it.
  let stopError;
  try {
    // A stop control can stop the instance and still report an error, so it
    // runs inside the block that starts the instance again.
    await ctx.a.stop().catch((err) => {
      stopError = err.message;
    });
    const down = await waitFor(async () => !(await ctx.a.up()), { timeoutMs: 60_000 });
    if (!down && stopError)
      return { result: "not checked", reason: `The stop control failed: ${stopError}.` };
    if (!down)
      return { result: "fail", reason: "The instance still answered a minute after stop." };
    const stoppedAt = Date.now();
    for (let i = 1; i <= 20; i++) {
      const c = code("R6", i);
      const sent = await ctx.slack.dm(ws.id, ws.guardian, ask(c));
      channel = sent.channel;
      codes.push(c);
      eventIds.push(sent.eventId);
    }
    await sleep(Math.max(0, env.stopSeconds * 1000 - (Date.now() - stoppedAt)));
    whileStopped = (await ctx.slack.posts({ team: ws.id, since })).length;
  } finally {
    await ctx.a.start();
  }
  const up = await waitFor(() => ctx.a.up(), { timeoutMs: env.timeouts.restartSeconds * 1000 });
  const evidence = {
    workspace: ws.id,
    channel,
    stopSeconds: env.stopSeconds,
    stopError,
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
