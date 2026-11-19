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
  const ws = ctx.wsA;
  const walk = await connectAs(ctx, ctx.a, ws);
  const romeFields = walk.approveScreens.filter((s) => !s.bySlack).flatMap((s) => s.fields);
  const slackScreens = walk.approveScreens.filter((s) => s.bySlack).length;
  const evidence = {
    workspace: ws.id,
    instance: ctx.a.name,
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
    };
  }
  ctx.bound.a = walk.connectionId ?? true;

  const accounts = await ctx.a.accounts();
  const account = walk.connectionId
    ? accounts.find((x) => x.connection === walk.connectionId)
    : accounts.find((x) => x.account.platform === "slack" && x.connection);
  evidence.connectionId = walk.connectionId;
  evidence.account = account ?? null;

  const reply = await oneReply(ctx, ws, "R1");
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
  else if (account.agent !== CONCIERGE)
    problems.push(`the connected account's agent is ${account.agent ?? "none"}, not the Concierge`);
  if (!reply.ok)
    problems.push(`the first direct message did not get exactly one reply (${reply.said})`);

  return problems.length
    ? {
        result: "fail",
        reason: `Connected: ${evidence.parts.connected}; replied: ${evidence.parts.replied}. ${problems.join("; ")}`,
        evidence,
      }
    : {
        result: "pass",
        reason:
          "Connected in one sign-in with 0 fields from Rome; the Concierge answers as the account with no link step.",
        evidence,
      };
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
