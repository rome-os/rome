// R1 (one sign-in, nothing pasted) and R3 (one workspace, one instance), and
// R2 (any workspace) as R1 from another workspace. Rule text: rule set v4 in
// the planner's rules.md. Checked at the connection's edges: the fake Slack,
// and what Rome has on record.

import { query } from "../lib/cloud.mjs";
import { code } from "../lib/codes.mjs";
import { waitFor } from "../lib/http.mjs";
import { dmOnRecord } from "../lib/record.mjs";

// The newest sign-in attempt: whether its outcome is gone and it is used up.
const ATTEMPT_SQL =
  "select result is null as cleared, consumed_at is not null as consumed from slack_app_installs order by created_at desc limit 1";

// The refusal must say why, in any words: the workspace is already connected
// to another Rome.
const TOLD_WHY = /already (connected|bound)|another Rome|workspace_bound/i;

/** Connects `inst` to workspace `ws` as its guardian, by Connect and the approve screen. */
export async function connectAs(ctx, inst, ws) {
  await ctx.slack.signIn(ws.id, ws.guardian);
  return inst.connect();
}

const yn = (b) => (b ? "yes" : "no");

/**
 * Whether a message Rome sends into `channel` arrives there. Through the
 * connection's port when the environment gives one: a send of a tagged text,
 * found at the fake by its tag. Without one, the post Rome makes in that
 * chat after `since` (the Concierge's answer to the message just recorded;
 * what it says is not read). Returns {ok, how, post}.
 */
export async function romeSends(ctx, inst, ws, channel, since, rule) {
  if (inst.hasPort) {
    const tag = code(`${rule}S`, 0);
    const sent = await inst.port("send", { chat: channel, text: `Sent through the port (${tag})` });
    const post = await waitFor(
      async () => (await ctx.slack.posts({ team: ws.id, channel, since })).find((p) => p.text?.includes(tag)),
      { timeoutMs: ctx.env.timeouts.replySeconds * 1000 },
    );
    return { ok: Boolean(post) && post.tokenKind !== "user", how: "port send", answered: sent, post: post ?? null };
  }
  const post = await waitFor(
    async () => (await ctx.slack.posts({ team: ws.id, channel, since }))[0],
    { timeoutMs: ctx.env.timeouts.replySeconds * 1000 },
  );
  return { ok: Boolean(post) && post.tokenKind !== "user", how: "Rome's post after the message (no port)", post: post ?? null };
}

export async function r1(ctx) {
  const { bound, ...scored } = await signInCheck(ctx, ctx.a, ctx.wsA, "R1");
  if (bound) ctx.bound.a = bound;
  return scored;
}

/**
 * R1's whole check: `inst` connects workspace `ws` in one sign-in with
 * nothing pasted, into a connection that names the workspace's account; one
 * direct message reaches Rome and one message Rome sends arrives. `rule` tags
 * the message. Returns the result plus `bound`, the new connection's id (true
 * when Rome names none), or null.
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
    ...(walk.presentedLink ? { presentedLink: walk.presentedLink } : {}),
    ...(walk.landedAt ? { landedAt: walk.landedAt } : {}),
  };
  if (walk.outcome !== "connected") {
    evidence.parts = { connected: "no", reached: "not tried", sent: "not tried" };
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

  const heard = await dmOnRecord(ctx, inst, ws, walk.connectionId, rule);
  const sent = await romeSends(ctx, inst, ws, heard.channel, heard.since, rule);
  evidence.firstMessage = { eventId: heard.eventId, tag: heard.tag, onRecord: heard.ok };
  evidence.romeSent = sent;
  evidence.parts = { connected: yn(Boolean(account)), reached: yn(heard.ok), sent: yn(sent.ok) };

  // Live: the newest sign-in attempt in Rome Cloud no longer holds its
  // outcome once the instance redeemed it.
  // v5: Rome Cloud keeps no sign-in attempt; the Worker binds at the
  // callback and holds the token, which R15 checks.
  const q = ctx.env.romeCloud?.query;
  if (ctx.env.gateway) evidence.signInAttempt = "v5: Rome Cloud keeps no sign-in attempt to clear (R15 covers the token)";
  else if (Array.isArray(q)) {
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
  else if (account.account.id && !new RegExp(`(^|[^A-Z0-9])${ws.id}([^A-Z0-9]|$)`).test(String(account.account.id)))
    problems.push(`the new connection's account ${account.account.id} does not name workspace ${ws.id}`);
  if (!heard.ok)
    problems.push(`the first direct message was not on record in Rome within ${ctx.env.timeouts.replySeconds} s`);
  if (!sent.ok)
    problems.push(
      sent.post?.tokenKind === "user"
        ? "Rome's message went out with a user token"
        : `no message Rome sent arrived in the direct message (${sent.how})`,
    );

  return problems.length
    ? {
        result: "fail",
        reason: `Connected: ${evidence.parts.connected}; reached Rome: ${evidence.parts.reached}; Rome's send arrived: ${evidence.parts.sent}. ${problems.join("; ")}`,
        evidence,
        bound,
      }
    : {
        result: "pass",
        reason: `Connected in one sign-in with 0 fields from Rome, as ${account.account.id ?? "a Slack account"}; a direct message is on record and Rome's send arrived (${sent.how}).`,
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
  const first = await dmOnRecord(ctx, ctx.a, ws, ctx.bound.a, "R3");
  const evidence = {
    workspace: ws.id,
    secondInstance: ctx.b.name,
    outcome: walk.outcome,
    toldWhy: walk.reason ?? null,
    connectedAccountsOnSecond: { before, after },
    firstStillWorks: { eventId: first.eventId, tag: first.tag, onRecord: first.ok },
    parts: {
      secondRefused: yn(walk.outcome === "refused" && after === before),
      firstStillHears: yn(first.ok),
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
  if (!first.ok) problems.push("a direct message to the first instance was not on record there");
  return problems.length
    ? {
        result: "fail",
        reason: `Second refused: ${evidence.parts.secondRefused}; first still hears: ${evidence.parts.firstStillHears}. ${problems.join("; ")}`,
        evidence,
      }
    : {
        result: "pass",
        reason: `Refused and told why: "${walk.reason}". A direct message to the first is on record there.`,
        evidence,
      };
}
