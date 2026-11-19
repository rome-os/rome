// R1 (one sign-in, nothing pasted) and R3 (one workspace binds to one
// instance). Rule text: rule set v1 in the planner's rules.md.

import { ask, code } from "../lib/codes.mjs";
import { awaitReplies, tally } from "../lib/replies.mjs";

const CONCIERGE = "core:concierge";

// The refusal must say why, in any words: the workspace is already connected
// to another Rome.
const TOLD_WHY = /already (connected|bound)|another Rome|workspace_bound/i;

const SEEDED = /\bR\d+[A-Z]?-\d\d-[0-9a-f]{4}\b/;

/**
 * Seeds one direct message from the workspace's guardian and reports whether
 * it got exactly one reply.
 */
export async function oneReply(ctx, ws, rule) {
  const c = code(rule, 0);
  const since = await ctx.slack.seq();
  const sent = await ctx.slack.dm(ws.id, ws.guardian, ask(c));
  const t = tally(
    await awaitReplies(ctx.slack, {
      team: ws.id,
      channel: sent.channel,
      since,
      codes: [c],
      timeoutMs: ctx.env.timeouts.replySeconds * 1000,
      settleMs: ctx.env.timeouts.settleSeconds * 1000,
    }),
  );
  // A reply carrying another seeded code answers another message, so only
  // replies with no code at all count against this one.
  const stray = t.repliesWithNoCode.filter((p) => !SEEDED.test(p.text ?? ""));
  return { ok: t.answeredOnce === 1 && stray.length === 0, eventId: sent.eventId, ...t };
}

/** Connects `inst` to workspace `ws` as its guardian, by Connect and the approve screen. */
export async function connectAs(ctx, inst, ws) {
  await ctx.slack.signIn(ws.id, ws.guardian);
  return inst.connect();
}

export async function r1(ctx) {
  const ws = ctx.wsA;
  const walk = await connectAs(ctx, ctx.a, ws);
  const romeFields = walk.approveScreens.filter((s) => !s.bySlack).flatMap((s) => s.fields);
  const evidence = {
    workspace: ws.id,
    instance: ctx.a.name,
    outcome: walk.outcome,
    setupFields: walk.setupFields,
    fieldsOnRomeScreens: romeFields,
    screens: walk.approveScreens,
    path: walk.visited,
    agentLinkCalls: 0,
  };
  if (walk.outcome !== "connected") {
    return { result: "fail", reason: `Connect did not finish: ${walk.reason}`, evidence };
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
    noCode: reply.repliesWithNoCode,
  };

  const problems = [];
  if (walk.setupFields.length) problems.push(`setup asked for ${walk.setupFields.length} field(s)`);
  if (romeFields.length)
    problems.push(`Rome's own screens asked for ${romeFields.length} field(s)`);
  if (!account) problems.push("no connected account for the new connection");
  else if (account.agent !== CONCIERGE)
    problems.push(`the connected account's agent is ${account.agent ?? "none"}, not the Concierge`);
  if (!reply.ok)
    problems.push(`the first direct message got ${reply.replies} replies, not exactly 1`);

  return problems.length
    ? { result: "fail", reason: problems.join("; "), evidence }
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
  };
  const problems = [];
  if (walk.outcome === "connected")
    problems.push("the second instance connected the same workspace");
  else if (walk.outcome !== "refused" || !TOLD_WHY.test(walk.reason ?? ""))
    problems.push(
      `the second connect ended ${walk.outcome} without saying the workspace is already connected (${walk.reason ?? "no reason"})`,
    );
  if (after !== before) problems.push("the second instance gained a connected account");
  if (!first.ok) problems.push(`a direct message to the first got ${first.replies} replies, not 1`);
  return problems.length
    ? { result: "fail", reason: problems.join("; "), evidence }
    : {
        result: "pass",
        reason: `Refused and told why: "${walk.reason}". The first still answers.`,
        evidence,
      };
}
