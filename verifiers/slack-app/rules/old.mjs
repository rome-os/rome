// R10 (one Slack entry). Rule text: rule set v4 in the planner's rules.md.
// Connect lists only Rome's Slack app; the older Slack bot and the old Slack
// sign-in cannot be started, and a stored connection of either kind is
// ignored at start: not listed, not answering, nothing sent through it.
// Runs last, on the second instance, since seeding the old connections
// writes there.

import { request, sleep } from "../lib/http.mjs";
import { dmOnRecord } from "../lib/record.mjs";
import { replyAfter } from "../lib/replies.mjs";
import { connectAs } from "./connect.mjs";

const SLACK = /slack/i;

const OLD_KINDS = ["slack_bot", "slack"];

/** An entry's visible name: the API's display name when it gives one, else "Slack". */
function visibleName(c) {
  const named = c?.displayName ?? c?.display_name ?? c?.name ?? c?.title;
  if (typeof named === "string" && named) return named;
  // A label that is the kind itself ("slack_app") is not what the page shows.
  if (typeof c?.label === "string" && c.label && c.label !== c.connectionKind && !/^[a-z0-9]+_[a-z0-9_]+$/.test(c.label)) return c.label;
  return "Slack";
}

/**
 * The Slack entries Connect shows (`GET /connections`), connected or not:
 * `official` counts the official kind's, `oldOffered` the old kinds still
 * offered for a new connection (a placeholder, id null).
 */
async function pickerSlack(inst, officialKind) {
  const res = await inst.call("/connections");
  if (!res.ok) return { error: `GET /connections: ${res.status}` };
  const list = Array.isArray(res.data) ? res.data : (res.data?.connections ?? []);
  const entries = list
    .filter((c) => SLACK.test(c.connectionKind ?? "") || SLACK.test(c.label ?? ""))
    .map((c) => ({ id: c.id ?? null, kind: c.connectionKind, label: c.label }));
  const official = entries.filter((e) => e.kind === officialKind);
  const oldOffered = entries.filter((e) => e.id === null && OLD_KINDS.includes(e.kind));
  return { entries, official: official.length, officialLabel: visibleName(list.find((c) => c.connectionKind === officialKind)), oldOffered: oldOffered.length };
}

/** Starts a new connection of `kind` through its public route; true when refused. */
async function newConnectRefused(inst, kind) {
  if (kind === "slack_bot") {
    const res = await inst.call("/connections/slack_bot/grants/bot/setup", { method: "POST", body: {} });
    const state = res.data?.state;
    const refused = !res.ok || state?.status === "failed";
    return { route: "POST /api/connections/slack_bot/grants/bot/setup", status: res.status, state: state?.status ?? null, refused };
  }
  // The old OAuth kind's start: refused unless it answers 2xx or sends the
  // browser on to a sign-in.
  const res = await request(`${inst.origin}/api/oauth/slack/start`, {
    redirect: "manual",
    headers: { origin: inst.origin, "sec-fetch-site": "same-origin", ...(inst.headers ?? {}) },
  });
  const location = res.headers.get("location");
  const refused = res.status >= 400 || (res.status >= 300 && res.status < 400 && /error|denied|unavailable/i.test(location ?? ""));
  return { route: "GET /api/oauth/slack/start", status: res.status, location, refused };
}

/** The guardian's direct message id in `team`, as the fake names it. */
async function guardianDm(ctx, team, user) {
  const w = (await ctx.slack.state()).workspaces.find((x) => x.id === team);
  return w?.members?.find((m) => m.id === user)?.im_channel ?? null;
}

/** slack_bot sends: the bot hears a direct message over Socket Mode and answers from its own app. */
async function botSends(ctx, ws, bot) {
  const dm = await guardianDm(ctx, ws.id, ws.guardian);
  const tries = [];
  for (let i = 1; i <= 3; i++) {
    const since = await ctx.slack.seq();
    let pushed;
    try {
      pushed = await ctx.slack.socketEvent(bot.app_id, {
        type: "message",
        channel_type: "im",
        channel: dm,
        user: ws.guardian,
        text: `Hello, could you say hello back? (R10 check ${i})`,
        ts: `${Math.floor(Date.now() / 1000)}.${String(i).padStart(6, "0")}`,
      });
    } catch (err) {
      tries.push({ error: err.message });
      continue;
    }
    await replyAfter(ctx.slack, { team: ws.id, channel: dm, since, timeoutMs: ctx.env.timeouts.replySeconds * 1000 });
    const posts = (await ctx.slack.posts({ team: ws.id, channel: dm, since })).filter((p) => p.appId === bot.app_id);
    tries.push({ acked: pushed?.acked ?? null, replies: posts.length });
    if (posts.length) return { ok: true, tries };
  }
  return { ok: false, tries };
}

export async function r10(ctx) {
  const inst = ctx.b;
  const ws = ctx.wsB;
  const officialKind = ctx.env.instances[1]?.connect?.kind ?? "slack_app";
  const evidence = {};
  const problems = [];
  const unchecked = [];
  const pickerHolds = (p, when) => {
    if (p.error) return unchecked.push(`picker ${when}: ${p.error}`);
    if (p.official !== 1) problems.push(`Connect shows ${p.official} entries of Rome's Slack app ${when}, not 1`);
    if (p.oldOffered) problems.push(`Connect offers ${p.oldOffered} old Slack kind(s) ${when}`);
  };
  pickerHolds((evidence.pickerBefore = await pickerSlack(inst, officialKind)), "before the upgrade");
  for (const kind of ["slack_bot", "slack"]) {
    const r = await newConnectRefused(inst, kind);
    evidence[`newConnect_${kind}`] = r;
    if (!r.refused) problems.push(`a new ${kind} connection could be started (${r.route} answered ${r.status})`);
  }
  // Rome's Slack app on B, which R10 disconnected.
  if (!(await inst.accounts()).some((x) => x.kind === officialKind)) {
    const walk = await connectAs(ctx, inst, ws).catch((e) => ({ outcome: "stuck", reason: e.message }));
    evidence.reconnect = { outcome: walk.outcome, reason: walk.reason ?? null };
    if (walk.outcome !== "connected")
      return { result: "not checked", reason: `Rome's Slack app could not be connected to ${ws.id} again: ${walk.reason}`, evidence };
  }
  const officialId = async () => (await inst.accounts()).find((x) => x.kind === officialKind)?.connection;
  const startSeq = await ctx.slack.seq();
  let old;
  try {
    old = await inst.seedOldConnections();
  } catch (err) {
    return { result: "not checked", reason: `the environment's seed of the old connections failed: ${err.message.slice(0, 300)}`, evidence };
  }
  if (!old?.slack_bot || !old?.slack) return { result: "not checked", reason: "the seed named no slack_bot or slack connection", evidence: { ...evidence, seed: old ?? null } };
  evidence.seed = old;
  evidence.steps = {};
  for (const when of ["after the upgrade", "after a restart"]) {
    if (when === "after a restart") {
      await inst.stop();
      await inst.start();
      const up = Date.now() + ctx.env.timeouts.restartSeconds * 1000;
      while (Date.now() < up && !(await inst.up())) await sleep(1000);
      await sleep(ctx.env.timeouts.settleSeconds * 1000);
    }
    const step = {};
    const held = await inst.accounts();
    step.held = held.map((x) => x.kind);
    const oldHeld = held.filter((x) => OLD_KINDS.includes(x.kind));
    if (oldHeld.length) problems.push(`${when}, Rome lists ${oldHeld.map((x) => x.kind).join(", ")}`);
    if (!held.some((x) => x.kind === officialKind)) problems.push(`${when}, Rome does not list Rome's Slack app`);
    step.bot = await botSends(ctx, ws, old.slack_bot);
    if (step.bot.ok) problems.push(`${when}, the older Slack bot still answered`);
    step.dm = await dmOnRecord(ctx, inst, ws, await officialId(), "R10D");
    if (!step.dm.ok) problems.push(`${when}, a direct message to Rome's Slack app was not on record`);
    evidence.steps[when] = step;
  }
  pickerHolds((evidence.pickerFinal = await pickerSlack(inst, officialKind)), "at the end");
  // Nothing went through the old sign-in or the older bot: no post from
  // either app, no call with the sign-in's user token.
  const posts = await ctx.slack.posts({ team: ws.id, since: startSeq });
  const calls = await ctx.slack.calls({ team: ws.id, since: startSeq });
  const oldApps = new Set([old.slack.app_id, old.slack_bot.app_id].filter(Boolean));
  evidence.throughOld = {
    posts: posts.filter((p) => oldApps.has(p.appId) || p.tokenKind === "user").map((p) => ({ channel: p.channel, appId: p.appId ?? null, tokenKind: p.tokenKind })),
    userTokenCalls: calls.filter((c) => c.tokenKind === "user").map((c) => c.method),
  };
  if (evidence.throughOld.posts.length) problems.push(`${evidence.throughOld.posts.length} post(s) went out through an old Slack connection`);
  if (evidence.throughOld.userTokenCalls.length)
    problems.push(`${evidence.throughOld.userTokenCalls.length} call(s) at Slack used the old sign-in's user token (${[...new Set(evidence.throughOld.userTokenCalls)].join(", ")})`);
  const said = Object.entries(evidence.steps)
    .map(([when, s]) => `${when}: listed ${s.held.join(", ") || "nothing"}; old bot answered ${s.bot.ok ? "yes" : "no"}; DM on record ${s.dm.ok ? "yes" : "no"}`)
    .join(". ");
  if (problems.length) return { result: "fail", reason: `${problems.join("; ")}. ${said}`, evidence };
  if (unchecked.length) return { result: "not checked", reason: `not all checked (${unchecked.join("; ")}). ${said}`, evidence };
  return { result: "pass", reason: said, evidence };
}
