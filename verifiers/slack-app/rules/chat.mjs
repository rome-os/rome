// R4 (direct messages), R6 (while Rome is down) and R7 (forged and
// misrouted). Rule text: rule set v4 in the planner's rules.md. Each is
// checked at the connection's edges: what the fake Slack sent, and what Rome
// has on record.

import { ask, code } from "../lib/codes.mjs";
import { sleep, waitFor } from "../lib/http.mjs";
import { dmOnRecord, onRecord } from "../lib/record.mjs";

/** Waits for the instance to stop answering, then for `body`; starts it again whatever happens. */
async function whileStopped(ctx, inst, body) {
  let stopError;
  try {
    await inst.stop().catch((err) => {
      stopError = err.message;
    });
    const down = await waitFor(async () => !(await inst.up()), { timeoutMs: 60_000 });
    if (!down) return { stopped: false, stopError };
    return { stopped: true, stopError, ...(await body()) };
  } finally {
    await inst.start();
  }
}

export async function r4(ctx) {
  if (!ctx.bound.a) return { result: "not checked", reason: "R1 made no connection to build on." };
  const ws = ctx.wsA;
  const cid = ctx.bound.a;
  const evidence = { workspace: ws.id };
  const problems = [];
  const unchecked = [];

  // 20 direct messages, one at a time: each is on record before the next.
  const since = await ctx.slack.seq();
  const steady = [];
  for (let i = 1; i <= 20; i++) steady.push(await dmOnRecord(ctx, ctx.a, ws, cid, "R4", i));
  const channel = steady[0].channel;
  ctx.fromA = {
    codes: steady.map((m) => m.tag),
    eventIds: steady.map((m) => m.eventId),
    since,
    channel,
  };
  const missed = steady.filter((m) => !m.ok).map((m) => m.tag);
  evidence.steady = { channel, eventIds: ctx.fromA.eventIds, notOnRecordInTime: missed };
  if (missed.length)
    problems.push(`${missed.length} of 20 direct messages were not on record within ${ctx.env.timeouts.replySeconds} s`);

  // None acknowledged before Rome accepted it. The order inside Rome Cloud
  // cannot be seen from the edges; the nearest sign of an early
  // acknowledgement is a loss when the instance stops while messages are in
  // flight. 10 sent: 3, a second for Rome to take them, the stop, then 7
  // while it is down.
  const burst = [];
  let stopAnswer = null;
  for (let i = 1; i <= 10; i++) {
    if (i === 4) {
      await sleep(1000);
      stopAnswer = await ctx.a.stop().catch((err) => ({ error: err.message }));
    }
    const tag = code("R4B", i);
    const sent = await ctx.slack.dm(ws.id, ws.guardian, ask(tag));
    burst.push({ tag, eventId: sent.eventId });
  }
  await ctx.a.start();
  const up = await waitFor(() => ctx.a.up(), { timeoutMs: ctx.env.timeouts.restartSeconds * 1000 });
  const inFlight = up
    ? await onRecord(ctx.a, channel, cid, burst.map((b) => b.tag), ctx.env.timeouts.replySeconds * 5 * 1000)
    : null;
  evidence.stopDuringBurst = {
    stopAnswer: stopAnswer ?? null,
    restarted: Boolean(up),
    eventIds: burst.map((b) => b.eventId),
    notOnRecord: inFlight?.missing ?? "instance did not come back",
  };
  if (!up) problems.push("the instance did not come back after the stop during the burst");
  else if (inFlight.missing.length)
    problems.push(`${inFlight.missing.length} of 10 direct messages sent while the instance stopped were not on record after it restarted`);

  // Slack sends one recorded event again: it is still on record once.
  const again = steady.find((m) => m.ok);
  if (!again) unchecked.push("no direct message was on record to redeliver");
  else {
    const r = await ctx.slack.redeliver(again.eventId);
    if (r === null) unchecked.push("the fake has no redeliver route");
    else {
      await sleep(ctx.env.timeouts.settleSeconds * 1000);
      const after = await onRecord(ctx.a, channel, cid, [again.tag], ctx.env.timeouts.replySeconds * 1000);
      evidence.redelivered = { eventId: again.eventId, answer: r, timesOnRecord: after.counts[again.tag] };
      if (after.counts[again.tag] !== 1)
        problems.push(`a redelivered event is on record ${after.counts[again.tag]} times, not once`);
    }
  }

  const parts = `steady ${20 - missed.length} of 20 on record; stop during a burst ${inFlight ? `${10 - inFlight.missing.length} of 10` : "not restarted"}; redelivered on record ${evidence.redelivered?.timesOnRecord ?? "?"} time(s)`;
  if (problems.length) return { result: "fail", reason: `${parts}. ${problems.join("; ")}`, evidence };
  if (unchecked.length)
    return { result: "not checked", reason: `${parts}. Not checked: ${unchecked.join("; ")}`, evidence };
  return {
    result: "pass",
    reason: `20 of 20 direct messages on record; 10 of 10 sent while the instance stopped mid-burst on record after restart; a redelivered event on record once. The order of acknowledgement inside Rome Cloud is covered by the product's tests (#2534).`,
    evidence,
  };
}

/** A delivery Rome Cloud itself answered: any status but none or a 5xx. */
const conclusive = (status) => Boolean(status) && status < 500;

export async function r7(ctx) {
  if (!ctx.bound.a) return { result: "not checked", reason: "R1 made no connection to build on." };
  const ws = ctx.wsA;
  const evidence = {};
  const problems = [];
  let partial = null;
  // A failed read is kept in the evidence whatever the result, so its cause
  // can be found even when R7 fails for another reason.
  const readErrors = [];
  const readable = async (read) => {
    try {
      return await read();
    } catch (err) {
      readErrors.push(err.message);
      partial ??= `a read of what Rome recorded failed: ${err.message}`;
      return null;
    }
  };

  // Forged: 10 events with a bad signature, then one good message. That it
  // is on record shows the path was open while the forged ones went by.
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
  // A post anywhere in the workspace before the good message is sent answers
  // a forged event, whatever it says. One that comes later shows up as more
  // than the good message's one reply.
  await sleep(ctx.env.timeouts.settleSeconds * 1000);
  const control = await dmOnRecord(ctx, ctx.a, ws, ctx.bound.a, "R7C");
  const others = (await ctx.slack.posts({ team: ws.id, since })).filter(
    (p) => p.seq <= control.since,
  );
  // The bot chat's own session: the People timeline leaves agent chats out.
  const recorded = control.channel ? await readable(() => ctx.a.recordedIn(control.channel, { connection: ctx.bound.a })) : null;
  // The good message must show in the same read, or an empty read proves
  // nothing about the forged ones.
  const sawGood = recorded?.some((b) => b.includes(control.tag));
  if (recorded && !sawGood)
    partial ??=
      "the read of what Rome recorded does not show the good message, so it cannot show the forged ones are absent";
  const recordedForged = recorded && forged.filter((f) => recorded.some((b) => b.includes(f.code)));
  evidence.forged = {
    sent: forged.flatMap((f) => f.tries.map((t) => t.eventId)),
    deliveryStatuses: forged.map((f) => f.tries.map((t) => t.status)),
    postsBeforeGoodMessage: others.map((p) => ({
      channel: p.channel,
      ts: p.ts,
      text: p.text?.slice(0, 120),
    })),
    recorded: recordedForged?.map((f) => f.eventId) ?? "not readable",
    goodMessageVisibleInRecord: Boolean(sawGood),
    goodMessageAfter: { eventId: control.eventId, onRecord: control.ok },
  };
  if (!control.ok) problems.push("the good message after the forged ones was not on record");
  if (others.length)
    problems.push(
      `${others.length} post(s) answered the forged events before the good message was sent`,
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
      ctx.b.recordedIn(ctx.fromA.channel, { connection: ctx.bound.b, noneIfMissing: true }),
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

  // v5: 10 deliveries into the instance's own mailbox not signed with its
  // key (5 with no signature, 5 with a wrong one) are refused: none is on
  // record, while a good message after them is.
  if (ctx.env.gateway) {
    const part = await unsignedDeliveries(ctx, ws);
    evidence.mailbox = part.evidence;
    if (part.problem) problems.push(part.problem);
    if (part.unchecked) partial ??= part.unchecked;
  }

  evidence.readErrors = readErrors;
  if (problems.length)
    return {
      result: "fail",
      reason: problems.join("; ") + (partial ? `. Also not checked: ${partial}` : ""),
      evidence,
    };
  if (partial)
    return { result: "not checked", reason: `No failure seen, but ${partial}.`, evidence };
  return {
    result: "pass",
    reason:
      "10 of 10 forged events dropped: none on record, nothing posted; the good message after them is on record. 0 of 20 events from workspace A reached the instance bound to B." +
      (evidence.mailbox?.sent ? ` ${evidence.mailbox.acceptedByMailbox} deliveries into the instance's mailbox not signed with its key: none on record.` : ""),
    evidence,
  };
}

/**
 * R7's v5 part: deliveries put straight into the first instance's relay
 * mailbox, through the verifier's agent run as that instance, carrying
 * Slack's own body shape with x-rome-slack but no signature or a wrong one.
 */
async function unsignedDeliveries(ctx, ws) {
  if (!ctx.agentA) return { evidence: "not checked: no as_instance control", unchecked: "the mailbox part had no as_instance control" };
  let box;
  try {
    box = await ctx.a.mailbox();
  } catch (err) {
    return { evidence: `not checked: ${err.message}`, unchecked: `the mailbox part could not read the instance's mailbox address (${err.message.slice(0, 120)})` };
  }
  if (!box?.depositUrl) return { evidence: "not checked: no mailbox control", unchecked: "the environment gives no mailbox control" };
  const w = (await ctx.slack.state()).workspaces.find((x) => x.id === ws.id);
  const dm = w?.members?.find((m) => m.id === ws.guardian)?.im_channel;
  const sent = [];
  for (let i = 1; i <= 10; i++) {
    const tag = code("R7M", i);
    const ts = `${Math.floor(Date.now() / 1000)}.${String(900000 + i)}`;
    const body = JSON.stringify({
      type: "event_callback",
      team_id: ws.id,
      api_app_id: (await ctx.slack.state()).app?.app_id,
      event_id: `Ev${tag.replace(/[^A-Za-z0-9]/g, "")}`,
      event_time: Math.floor(Date.now() / 1000),
      event: { type: "message", channel_type: "im", channel: dm, user: ws.guardian, text: ask(tag), ts },
    });
    const signature = i <= 5 ? undefined : "0".repeat(64);
    const r = await ctx.agentA.op("deposit", { url: box.depositUrl, body, ...(signature ? { signature } : {}) });
    sent.push({ tag, signature: signature ? "wrong" : "none", mailboxAnswered: r.status });
  }
  const accepted = sent.filter((x) => x.mailboxAnswered >= 200 && x.mailboxAnswered < 300).length;
  const control = await dmOnRecord(ctx, ctx.a, ws, ctx.bound.a, "R7N");
  const recorded = control.ok ? await ctx.a.recordedIn(dm, { connection: ctx.bound.a }) : null;
  const onRecord = recorded ? sent.filter((x) => recorded.some((t) => t.includes(x.tag))).map((x) => x.tag) : null;
  const evidence = { sent, acceptedByMailbox: accepted, goodMessageAfter: { tag: control.tag, onRecord: control.ok }, unsignedOnRecord: onRecord };
  if (!accepted) return { evidence, unchecked: "the mailbox took none of the 10 deliveries, so the instance never saw them" };
  if (!control.ok) return { evidence, unchecked: "the good message after the deliveries was not on record, so their absence shows nothing" };
  if (onRecord.length) return { evidence, problem: `${onRecord.length} of ${accepted} deliveries not signed with the instance's key were on record` };
  return { evidence };
}

export async function r6(ctx) {
  if (!ctx.bound.a) return { result: "not checked", reason: "R1 made no connection to build on." };
  const ws = ctx.wsA;
  const env = ctx.env;
  const tags = [];
  const eventIds = [];
  let channel;
  const run = await whileStopped(ctx, ctx.a, async () => {
    const stoppedAt = Date.now();
    for (let i = 1; i <= 20; i++) {
      const tag = code("R6", i);
      const sent = await ctx.slack.dm(ws.id, ws.guardian, ask(tag));
      channel = sent.channel;
      tags.push(tag);
      eventIds.push(sent.eventId);
    }
    await sleep(Math.max(0, env.stopSeconds * 1000 - (Date.now() - stoppedAt)));
    return {};
  });
  const evidence = { workspace: ws.id, channel, stopSeconds: env.stopSeconds, stopError: run.stopError, eventIds };
  if (!run.stopped && run.stopError)
    return { result: "not checked", reason: `The stop control failed: ${run.stopError}.`, evidence };
  if (!run.stopped)
    return { result: "fail", reason: "The instance still answered a minute after stop.", evidence };
  const up = await waitFor(() => ctx.a.up(), { timeoutMs: env.timeouts.restartSeconds * 1000 });
  if (!up) return { result: "fail", reason: "The instance did not come back after start.", evidence };
  const got = await onRecord(ctx.a, channel, ctx.bound.a, tags, env.timeouts.replySeconds * 5 * 1000);
  evidence.notOnRecord = got.missing;
  evidence.deliveries = await Promise.all(
    eventIds.map(async (id) => {
      try {
        return { id, attempts: (await ctx.slack.deliveries(id)).map((d) => ({ at: d.at, status: d.status ?? d.outcome ?? null })) };
      } catch (err) {
        return { id, error: err.message };
      }
    }),
  );
  return got.missing.length
    ? {
        result: "fail",
        reason: `${20 - got.missing.length} of 20 messages sent during a ${env.stopSeconds} s stop were on record after the restart`,
        evidence,
      }
    : {
        result: "pass",
        reason: `20 of 20 messages sent during a ${env.stopSeconds} s stop are on record after the restart.`,
        evidence,
      };
}
