// R1 (one sign-in, nothing pasted) and R3 (one workspace binds to one
// instance). Rule text: rule set v1 in the planner's rules.md.

import { query } from "../lib/cloud.mjs";
import { ask, code } from "../lib/codes.mjs";
import { sleep } from "../lib/http.mjs";
import { allOnce, replyAfter, summary, tally } from "../lib/replies.mjs";

const CONCIERGE = "core:concierge";

// The newest sign-in attempt: whether its outcome is gone and it is used up.
const ATTEMPT_SQL =
  "select result is null as cleared, consumed_at is not null as consumed from slack_app_installs order by created_at desc limit 1";

// The refusal must say why, in any words: the workspace is already connected
// to another Rome.
const TOLD_WHY = /already (connected|bound)|another Rome|workspace_bound/i;

/**
 * Seeds one direct message from the workspace's guardian and reports whether
 * it got exactly one reply, in any words, and nothing anywhere else.
 */
export async function oneReply(ctx, ws, rule) {
  const tag = code(rule, 0);
  const since = await ctx.slack.seq();
  const sent = await ctx.slack.dm(ws.id, ws.guardian, ask(tag));
  await replyAfter(ctx.slack, {
    team: ws.id,
    channel: sent.channel,
    since,
    timeoutMs: ctx.env.timeouts.replySeconds * 1000,
  });
  await sleep(ctx.env.timeouts.settleSeconds * 1000);
  const t = tally(await ctx.slack.posts({ team: ws.id, since }), {
    channel: sent.channel,
    sent: [{ tag, since }],
  });
  return {
    ok: allOnce(t),
    tag,
    since,
    eventId: sent.eventId,
    channel: sent.channel,
    replies: t.repliesInChat,
    said: summary(t),
    ...t,
  };
}

/** Connects `inst` to workspace `ws` as its guardian, by Connect and the approve screen. */
export async function connectAs(ctx, inst, ws) {
  await ctx.slack.signIn(ws.id, ws.guardian);
  return inst.connect();
}

const yn = (b) => (b ? "yes" : "no");

export async function r1(ctx) {
  const { bound, ...scored } = await signInCheck(ctx, ctx.a, ctx.wsA, "R1");
  if (bound) ctx.bound.a = bound;
  return scored;
}

/**
 * R1's whole check: `inst` connects workspace `ws` in one sign-in with
 * nothing pasted, and its guardian's first direct message is answered by the
 * Concierge. `rule` tags the message. Returns the result plus `bound`, the
 * new connection's id (true when Rome names none), or null.
 */
async function signInCheck(ctx, inst, ws, rule) {
  const walk = await connectAs(ctx, inst, ws);
  const romeFields = walk.approveScreens.filter((s) => !s.bySlack).flatMap((s) => s.fields);
  const slackScreens = walk.approveScreens.filter((s) => s.bySlack).length;
  const evidence = {
    workspace: ws.id,
    instance: inst.name,
    outcome: walk.outcome,
    setupFields: walk.setupFields,
    fieldsOnRomeScreens: romeFields,
    signIns: walk.signIns,
    screens: walk.approveScreens,
    path: walk.visited,
    agentLinkCalls: 0,
  };
  if (walk.outcome !== "connected") {
    evidence.parts = { connected: "no", replied: "not tried" };
    return {
      result: "fail",
      reason: `Connected: no. Connect did not finish: ${walk.reason}`,
      evidence,
      bound: null,
    };
  }
  const bound = walk.connectionId ?? true;

  const accounts = await inst.accounts();
  const account = walk.connectionId
    ? accounts.find((x) => x.connection === walk.connectionId)
    : accounts.find((x) => x.account?.platform === "slack" && x.connection);
  evidence.connectionId = walk.connectionId;
  evidence.account = account ?? null;

  const reply = await oneReply(ctx, ws, rule);
  evidence.firstMessage = {
    eventId: reply.eventId,
    replies: reply.replies,
    postsElsewhere: reply.postsElsewhere,
  };
  // Kept apart so a silent agent is not read as a failed connect.
  evidence.parts = { connected: yn(Boolean(account)), replied: yn(reply.ok) };

  // Live: the newest sign-in attempt in Rome Cloud no longer holds its
  // outcome once the instance redeemed it.
  const q = ctx.env.romeCloud?.query;
  if (Array.isArray(q)) {
    try {
      const [row] = await query(q, ATTEMPT_SQL);
      evidence.signInAttempt = row ?? null;
      // No row at all: the attempt was deleted, which clears it too.
      evidence.parts.attemptCleared = row ? yn(row.cleared === true) : "yes (no attempt row left)";
    } catch (err) {
      evidence.signInAttempt = `not checked: ${err.message}`;
    }
  } else evidence.signInAttempt = "not checked: the environment gives no rome_cloud.query";

  const problems = [];
  if (evidence.parts.attemptCleared === "no")
    problems.push("Rome Cloud's sign-in attempt still holds its outcome after the redemption");
  if (walk.setupFields.length) problems.push(`setup asked for ${walk.setupFields.length} field(s)`);
  if (romeFields.length)
    problems.push(`Rome's own screens asked for ${romeFields.length} field(s)`);
  if (walk.signIns !== 1) problems.push(`Connect took ${walk.signIns} sign-ins, not 1`);
  if (slackScreens > 1) problems.push(`Slack asked for approval ${slackScreens} times, not once`);
  if (!account) problems.push("no connected account for the new connection");
  else if (account.account?.platform !== "slack")
    problems.push(`the new connection's account is ${JSON.stringify(account.account)}, not a Slack account`);
  else if (account.agent !== CONCIERGE)
    problems.push(`the connected account's agent is ${account.agent ?? "none"}, not the Concierge`);
  if (!reply.ok)
    problems.push(`the first direct message did not get exactly one reply (${reply.said})`);

  return problems.length
    ? {
        result: "fail",
        reason: `Connected: ${evidence.parts.connected}; replied: ${evidence.parts.replied}. ${problems.join("; ")}`,
        evidence,
        bound,
      }
    : {
        result: "pass",
        reason:
          "Connected in one sign-in with 0 fields from Rome; the Concierge answers as the account with no link step.",
        evidence,
        bound,
      };
}

/**
 * R2: R1's whole check from a workspace that is not the app's home one and
 * that no instance is bound to. First the negative, so the pass means
 * something: with the app's distribution off in the fake, the same sign-in
 * is refused by Slack and nothing connects. Runs after R8, on the first
 * instance, whose workspace R8 disconnected.
 */
export async function r2(ctx) {
  const ws = ctx.wsC;
  if (!ws)
    return {
      result: "not checked",
      reason: "the environment has no workspace that is neither the home one nor bound",
    };
  const inst = ctx.a;
  const evidence = { workspace: ws.id, home: ctx.homeTeam ?? null, instance: inst.name };

  // Whatever Slack connection the instance still holds goes first, so the
  // check does not hang on how many workspaces one instance can hold.
  const left = (await inst.accounts()).filter((x) => (x.account?.platform === "slack" || /^slack/.test(x.kind ?? "")) && x.connection);
  evidence.disconnectedFirst = [];
  for (const x of left) {
    await inst.disconnect(x.connection);
    evidence.disconnectedFirst.push(x.connection);
  }

  let off;
  try {
    off = await ctx.slack.setDistributed(false);
  } catch (err) {
    return { result: "not checked", reason: `the fake's distribution switch failed: ${err.message}`, evidence };
  }
  if (off.distributed !== false)
    return {
      result: "not checked",
      reason: "the fake did not turn its distribution off, so a refusal cannot be shown",
      evidence,
    };
  let negative;
  try {
    const since = await ctx.slack.seq();
    const before = (await inst.accounts()).filter((x) => x.connection).length;
    const walk = await connectAs(ctx, inst, ws).catch((e) => ({ outcome: "stuck", reason: e.message }));
    const after = (await inst.accounts()).filter((x) => x.connection).length;
    const answers = (await ctx.slack.approvals(since)).filter((a) => a.teamId === ws.id);
    negative = {
      outcome: walk.outcome,
      reason: walk.reason ?? null,
      approvals: answers,
      connectedAccounts: { before, after },
      refusedBySlack: answers.some((a) => a.outcome === "refused"),
    };
  } finally {
    await ctx.slack.setDistributed(true);
  }
  evidence.distributionOff = negative;
  if (negative.outcome === "connected" || negative.connectedAccounts.after !== negative.connectedAccounts.before)
    return {
      result: "fail",
      reason: `with the app's distribution off, ${ws.id} still connected, so Connect does not go through Slack's approval`,
      evidence,
    };
  if (!negative.refusedBySlack)
    return {
      result: "not checked",
      reason: `with distribution off, Slack never refused ${ws.id} (the sign-in ended ${negative.outcome}: ${negative.reason}), so a pass would mean nothing`,
      evidence,
    };

  const since = await ctx.slack.seq();
  const r = await signInCheck(ctx, inst, ws, "R2");
  const answers = (await ctx.slack.approvals(since)).filter((a) => a.teamId === ws.id);
  evidence.distributionOn = { ...r.evidence, approvals: answers };
  const approvedThere = answers.some((a) => a.outcome === "approved");
  if (r.result === "pass" && !approvedThere)
    return {
      result: "fail",
      reason: `connected, but Slack recorded no approval from ${ws.id}`,
      evidence,
    };
  const neg = `With distribution off, Slack refused ${ws.id} and nothing connected.`;
  return r.result === "pass"
    ? {
        result: "pass",
        reason: `${ws.id} is not the home workspace and no instance was bound to it. ${neg} With it on: ${r.reason}`,
        evidence,
      }
    : { result: r.result, reason: `From ${ws.id}, not the home workspace: ${r.reason} ${neg}`, evidence };
}

export async function r3(ctx) {
  if (!ctx.bound.a) return { result: "not checked", reason: "R1 made no connection to build on." };
  const ws = ctx.wsA;
  const before = (await ctx.b.accounts()).filter((x) => x.connection).length;
  const walk = await connectAs(ctx, ctx.b, ws);
  const after = (await ctx.b.accounts()).filter((x) => x.connection).length;
  const first = await oneReply(ctx, ws, "R3");
  const evidence = {
    workspace: ws.id,
    secondInstance: ctx.b.name,
    outcome: walk.outcome,
    toldWhy: walk.reason ?? null,
    connectedAccountsOnSecond: { before, after },
    firstStillWorks: { eventId: first.eventId, replies: first.replies },
    // Kept apart so a silent agent is not read as a failed refusal.
    parts: {
      secondRefused: yn(walk.outcome === "refused" && after === before),
      firstReplied: yn(first.ok),
    },
  };
  const problems = [];
  if (walk.outcome === "connected")
    problems.push("the second instance connected the same workspace");
  else if (walk.outcome !== "refused" || !TOLD_WHY.test(walk.reason ?? ""))
    problems.push(
      `the second connect ended ${walk.outcome} without saying the workspace is already connected (${walk.reason ?? "no reason"})`,
    );
  if (after !== before) problems.push("the second instance gained a connected account");
  if (!first.ok)
    problems.push(`a direct message to the first did not get exactly one reply (${first.said})`);
  return problems.length
    ? {
        result: "fail",
        reason: `Second refused: ${evidence.parts.secondRefused}; first replied: ${evidence.parts.firstReplied}. ${problems.join("; ")}`,
        evidence,
      }
    : {
        result: "pass",
        reason: `Refused and told why: "${walk.reason}". The first still answers.`,
        evidence,
      };
}
