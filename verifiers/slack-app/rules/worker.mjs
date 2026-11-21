// Rule set v5, the slack-gateway Worker's side, scored with the verifier's
// stand-in instance (gateway/agent.mjs) in place of Rome. Each check reads the
// two edges the Worker has: the fake Slack, and what reached the instance (its
// relay mailbox and the Worker's answers). The parts a rule promises of Rome
// itself (recording, "broken", refusing a badly signed delivery, a port) are
// named in the result as needing the Rome side.

import { secretTotal } from "../lib/gateway.mjs";
import { code } from "../lib/codes.mjs";
import { sleep } from "../lib/http.mjs";
import { ALLOWED, OTHERS } from "./port.mjs";

const ROME_SIDE = "needs the Rome side";

/** A result with the Rome side's parts named. */
function result(problems, said, evidence, romeSide = []) {
  if (romeSide.length) evidence.romeSide = romeSide.map((p) => `${p}: ${ROME_SIDE}`);
  const tail = romeSide.length ? ` Not scored here (${ROME_SIDE}): ${romeSide.join("; ")}.` : "";
  if (problems.length) return { result: "fail", reason: `${said}. ${problems.join("; ")}.${tail}`, evidence };
  return { result: "pass", reason: `Worker side: ${said}.${tail}`, evidence };
}

/** Event ids of the frames in `frames`. */
const ids = (frames) => new Set(frames.map((f) => f.eventId));

/** Sends `n` direct messages from the guardian of `ws`, one at a time; each with its delivery. */
async function directMessages(ctx, ws, rule, n, from = 1) {
  const sent = [];
  for (let i = from; i < from + n; i++) {
    const tag = code(rule, i);
    const r = await ctx.slack.dm(ws.id, ws.guardian, `A direct message (${tag})`);
    sent.push({ tag, eventId: r.eventId, channel: r.channel, delivery: r.delivery?.status ?? null });
  }
  return sent;
}

/** Drains `inst` until every sent event is in, for up to `seconds`. */
async function arrive(inst, sent, seconds) {
  const want = sent.map((s) => s.eventId);
  const have = ids(inst.frames);
  const missing = want.filter((id) => !have.has(id));
  if (missing.length) await inst.drain({ ms: seconds * 1000, until: missing });
  const now = ids(inst.frames);
  const frames = inst.frames.filter((f) => want.includes(f.eventId));
  return {
    missing: sent.filter((s) => !now.has(s.eventId)).map((s) => s.tag),
    unsigned: frames.filter((f) => !f.signed || f.slackHeader !== "1").map((f) => f.eventId),
    copies: frames.length,
  };
}

/** Connects both stand-in instances and binds workspace A to the first, B to the second. */
export async function setup(ctx) {
  const out = {};
  for (const [inst, ws] of [
    [ctx.a, ctx.wsA],
    [ctx.b, ctx.wsB],
  ]) {
    const connected = await inst.connect();
    const bound = connected.status === 200 ? await inst.op("bind", { team: ws.id, user: ws.guardian }) : null;
    out[inst.name] = { connect: connected.status, depositKey: Boolean(inst.depositKey), bind: bound?.status ?? null, bindBody: bound?.body ?? null };
    ctx.bound[inst === ctx.a ? "a" : "b"] = bound?.status === 200 && bound.body?.teamId === ws.id;
  }
  return out;
}

export async function r3(ctx) {
  if (!ctx.bound.a || !ctx.bound.b) return { result: "not checked", reason: "the stand-in instances could not be bound" };
  const evidence = {};
  const problems = [];
  // The second instance connects workspace A, which the first holds.
  const second = await ctx.b.op("bind", { team: ctx.wsA.id, user: ctx.wsA.guardian });
  evidence.secondBind = { status: second.status, body: second.body };
  if (second.status === 200) problems.push("the Worker bound workspace A to the second instance");
  else if (!(second.status === 409 && second.body?.error)) problems.push(`the second bind answered ${second.status} without saying why`);
  // The first still holds it and works.
  const listed = await ctx.a.op("workspaces");
  evidence.firstHolds = (listed.body?.workspaces ?? []).map((w) => w.teamId);
  if (!evidence.firstHolds.includes(ctx.wsA.id)) problems.push("the first instance no longer holds workspace A");
  const sent = await directMessages(ctx, ctx.wsA, "W3", 1);
  const got = await arrive(ctx.a, sent, ctx.env.timeouts.replySeconds);
  evidence.dmAfter = { sent, ...got };
  if (got.missing.length) problems.push("a direct message to the first instance did not reach its mailbox");
  const elsewhere = (await ctx.b.drain({ ms: 3000 })).filter((f) => f.team === ctx.wsA.id);
  if (elsewhere.length) problems.push(`${elsewhere.length} event(s) of workspace A reached the second instance`);
  return result(problems, `a second instance's bind of A answered ${second.status} ${second.body?.error ?? ""}; the first holds A and its direct message arrived`, evidence, [
    "the second instance's Connect shows the refusal and why",
  ]);
}

export async function r9(ctx) {
  if (!ctx.bound.a) return { result: "not checked", reason: "the stand-in instance could not be bound" };
  const ws = ctx.wsA;
  const evidence = { others: [] };
  const problems = [];
  const dm = (await ctx.slack.state()).workspaces.find((w) => w.id === ws.id)?.members?.find((m) => m.id === ws.guardian)?.im_channel;
  const tag = code("W9S", 1);
  const since = await ctx.slack.seq();
  const sent = await ctx.a.op("call", { team: ws.id, method: "chat.postMessage", args: { channel: dm, text: `Through the Worker (${tag})` } });
  const post = (await ctx.slack.posts({ team: ws.id, channel: dm, since })).find((p) => p.text?.includes(tag));
  evidence.send = { status: sent.status, ok: sent.body?.ok ?? null, arrived: Boolean(post), tokenKind: post?.tokenKind ?? null };
  if (!post) problems.push("a send through the Worker did not arrive");
  else if (post.tokenKind !== "bot") problems.push(`a send went out with a ${post.tokenKind} token`);
  const read = await ctx.a.op("call", { team: ws.id, method: "conversations.history", args: { channel: dm, limit: 15 } });
  const holds = JSON.stringify(read.body ?? "").includes(tag);
  evidence.read = { status: read.status, holdsTheSend: holds, error: read.body?.error ?? null };
  if (!holds && read.body?.error !== "ratelimited") problems.push("a read through the Worker did not hold the message just sent");
  for (const o of [...OTHERS, { method: "auth.test", args: {} }]) {
    const before = await ctx.slack.seq();
    const answer = await ctx.a.op("call", { team: ws.id, method: o.method, args: o.args });
    const made = (await ctx.slack.calls({ method: o.method, since: before })).length;
    evidence.others.push({ method: o.method, status: answer.status, error: answer.body?.error ?? null, callsAtSlack: made });
    if (answer.status < 400) problems.push(`the Worker did not refuse ${o.method}`);
    if (made) problems.push(`${o.method} reached Slack ${made} time(s)`);
  }
  // Every call the fake saw this run: send, read and the connection's upkeep, never a user token.
  const calls = await ctx.slack.calls({ since: ctx.runSince });
  const outside = calls.filter((c) => !ALLOWED.has(c.method));
  const user = calls.filter((c) => c.tokenKind === "user");
  evidence.audit = { calls: calls.length, outside: outside.map((c) => c.method), userToken: user.map((c) => c.method) };
  if (outside.length) problems.push(`${outside.length} call(s) at Slack outside send and read (${[...new Set(outside.map((c) => c.method))].join(", ")})`);
  if (user.length) problems.push(`${user.length} call(s) at Slack used a user token`);
  return result(
    problems,
    `a send arrived from the bot; a read held it; ${evidence.others.length} other methods were refused with no call at Slack; ${calls.length} calls at Slack this run, ${outside.length} outside send and read`,
    evidence,
    ["the instance's own port refusing other methods"],
  );
}

export async function r4(ctx) {
  if (!ctx.bound.a) return { result: "not checked", reason: "the stand-in instance could not be bound" };
  const sent = await directMessages(ctx, ctx.wsA, "W4", 20);
  ctx.r4Sent = sent;
  const got = await arrive(ctx.a, sent, ctx.env.timeouts.replySeconds * 2);
  const notAccepted = sent.filter((s) => s.delivery !== 200).map((s) => `${s.tag} (${s.delivery})`);
  const evidence = { sent, ...got, notAccepted };
  const problems = [];
  if (got.missing.length) problems.push(`${got.missing.length} of 20 did not reach the instance's mailbox (${got.missing.join(", ")})`);
  if (got.unsigned.length) problems.push(`${got.unsigned.length} arrived without the Worker's signature`);
  if (notAccepted.length) problems.push(`${notAccepted.length} of 20 were not answered 200 to Slack`);
  // A redelivery of one event: the Worker deposits it again; that it is
  // recorded once is Rome's part.
  return result(problems, `${20 - got.missing.length} of 20 direct messages reached the mailbox, signed, each answered 200 to Slack`, evidence, [
    "each on record in Rome before the mailbox is acknowledged",
  ]);
}

export async function r5(ctx) {
  if (!ctx.bound.a) return { result: "not checked", reason: "the stand-in instance could not be bound" };
  const ws = ctx.wsA;
  const w = (await ctx.slack.state()).workspaces.find((x) => x.id === ws.id);
  const member = w?.members?.find((m) => m.id !== ws.guardian && !m.is_bot && !m.is_restricted)?.id ?? ws.guardian;
  const sent = [];
  for (let i = 1; i <= 10; i++) {
    const tag = code("W5", i);
    const root = i > 5 ? await ctx.slack.groupMessage(ws.id, member, `A thread for the mention ${tag}.`) : null;
    const r = await ctx.slack.mention(ws.id, ws.guardian, `<@bot> a mention (${tag})`, root?.channel, root ? { thread_ts: root.ts } : {});
    sent.push({ tag, eventId: r.eventId, thread: root?.ts ?? null, delivery: r.delivery?.status ?? null });
  }
  const got = await arrive(ctx.a, sent, ctx.env.timeouts.replySeconds * 2);
  const frames = ctx.a.frames;
  const wrongThread = sent
    .filter((s) => s.thread)
    .filter((s) => {
      const f = frames.find((x) => x.eventId === s.eventId);
      return f && !String(f.body).includes(s.thread);
    })
    .map((s) => s.tag);
  const problems = [];
  if (got.missing.length) problems.push(`${got.missing.length} of 10 mentions did not reach the mailbox (${got.missing.join(", ")})`);
  if (wrongThread.length) problems.push(`${wrongThread.length} mention(s) in a thread arrived without their thread`);
  if (got.unsigned.length) problems.push(`${got.unsigned.length} arrived without the Worker's signature`);
  return result(problems, `${10 - got.missing.length} of 10 mentions reached the mailbox, the 5 in threads with their thread`, { sent, ...got, wrongThread }, [
    "each on record in Rome, naming Rome's account as mentioned",
  ]);
}

export async function r7(ctx) {
  if (!ctx.bound.a || !ctx.bound.b) return { result: "not checked", reason: "the stand-in instances could not be bound" };
  const evidence = {};
  const problems = [];
  // 10 events with a bad signature: refused, and in neither mailbox.
  const forged = [];
  for (let i = 1; i <= 10; i++) {
    const r = await ctx.slack.forged(ctx.wsA.id, ctx.wsA.guardian, `A forged message (${code("W7F", i)})`);
    forged.push({ eventId: r.eventId, delivery: r.delivery?.status ?? null });
  }
  await ctx.a.drain({ ms: 5000 });
  await ctx.b.drain({ ms: 3000 });
  const reached = forged.filter((f) => ids([...ctx.a.frames, ...ctx.b.frames]).has(f.eventId));
  const accepted = forged.filter((f) => f.delivery !== null && f.delivery < 400);
  evidence.forged = { sent: forged, reached: reached.length, answeredBelow400: accepted.length };
  if (reached.length) problems.push(`${reached.length} of 10 forged events reached a mailbox`);
  if (accepted.length) problems.push(`${accepted.length} of 10 forged events were answered ${accepted[0].delivery} to Slack`);
  // R4's 20 events of workspace A: none in the mailbox of the instance bound to B.
  const ofA = (ctx.r4Sent ?? []).map((s) => s.eventId);
  const misrouted = ctx.b.frames.filter((f) => ofA.includes(f.eventId) || f.team === ctx.wsA.id);
  evidence.misrouted = { eventsOfA: ofA.length, inB: misrouted.length };
  if (!ofA.length) problems.push("R4's events of workspace A were not there to check");
  if (misrouted.length) problems.push(`${misrouted.length} event(s) of workspace A reached the instance bound to B`);
  return result(problems, `0 of 10 forged events reached a mailbox (${10 - accepted.length} refused to Slack); ${misrouted.length} of ${ofA.length} events of A reached B's mailbox`, evidence, [
    "10 deliveries into an instance's mailbox not signed with its key are refused by the instance",
  ]);
}

export async function r6(ctx) {
  if (!ctx.bound.a) return { result: "not checked", reason: "the stand-in instance could not be bound" };
  // The stand-in instance is "down": nothing drains its mailbox while 20
  // direct messages are sent and the stop lasts.
  const stopSeconds = ctx.env.stopSeconds ?? 120;
  const started = Date.now();
  const sent = await directMessages(ctx, ctx.wsA, "W6", 20);
  const left = stopSeconds * 1000 - (Date.now() - started);
  if (left > 0) await sleep(left);
  const got = await arrive(ctx.a, sent, ctx.env.timeouts.replySeconds * 2);
  const notAccepted = sent.filter((s) => s.delivery !== 200).length;
  const problems = [];
  if (got.missing.length) problems.push(`${got.missing.length} of 20 were not in the mailbox after ${stopSeconds} s undrained (${got.missing.join(", ")})`);
  if (notAccepted) problems.push(`${notAccepted} of 20 were not answered 200 to Slack while the instance was down`);
  return result(problems, `${20 - got.missing.length} of 20 direct messages sent while nothing drained the mailbox for ${stopSeconds} s were there after`, { sent, ...got, stopSeconds }, [
    "the instance's own stop and start",
  ]);
}

/** Every Slack token the fake issued, from its control API; null when it gives none. */
export async function issuedTokens(ctx) {
  const url = ctx.env.gateway?.tokens ?? `${ctx.env.slack.control.replace(/\/$/, "")}/tokens`;
  try {
    const r = await fetch(url);
    if (!r.ok) return null;
    const data = await r.json();
    const list = Array.isArray(data) ? data : (data.tokens ?? []);
    return list.map((t) => (typeof t === "string" ? { value: t } : { value: t.value ?? t.token, team: t.team ?? t.teamId, kind: t.kind, app: t.app ?? null })).filter((t) => t.value);
  } catch {
    return null;
  }
}

/** Lines of a log control (argv or shell command); null without one. */
export async function logLines(target) {
  if (!target) return null;
  const { execFile } = await import("node:child_process");
  return new Promise((resolve) => {
    const cb = (err, stdout) => resolve(err && !stdout ? null : String(stdout).split("\n"));
    if (Array.isArray(target)) execFile(target[0], target.slice(1), { maxBuffer: 64 << 20 }, cb);
    else execFile("sh", ["-c", target], { maxBuffer: 64 << 20 }, cb);
  });
}

export async function r15(ctx) {
  if (!ctx.bound.a || !ctx.bound.b) return { result: "not checked", reason: "the stand-in instances could not be bound" };
  const evidence = {};
  const problems = [];
  const romeSide = [];
  const tokens = await issuedTokens(ctx);
  if (!tokens?.length) return { result: "not checked", reason: "the fake Slack lists no tokens it issued (GET /_control/tokens)" };
  // Rome's app's tokens: the older apps R10 seeds keep theirs on the instance by design.
  const romeApp = (await ctx.slack.state()).app?.app_id;
  const ofApp = tokens.filter((t) => !t.app || !romeApp || t.app === romeApp);
  evidence.tokens = { issued: tokens.length, searched: ofApp.length };
  const holds = (text) => ofApp.filter((t) => String(text).includes(t.value));
  // Sent to the instance: every answer the Worker, Cloud or the mailbox gave
  // either stand-in instance this run, frames included.
  const sentTo = [];
  for (const inst of [ctx.a, ctx.b]) {
    for (const a of inst.answers) if (holds(JSON.stringify(a.out)).length) sentTo.push({ instance: inst.name, op: a.op });
    for (const f of inst.frames) if (holds(f.body).length || holds(JSON.stringify(f.headers)).length) sentTo.push({ instance: inst.name, frame: f.eventId });
  }
  evidence.sentToInstance = { answers: ctx.a.answers.length + ctx.b.answers.length, frames: ctx.a.frames.length + ctx.b.frames.length, holdingAToken: sentTo };
  if (sentTo.length) problems.push(`${sentTo.length} answer(s) or delivery(ies) to an instance held a Slack token`);
  // Logged by the Worker.
  const workerLog = await logLines(ctx.env.gateway?.logs);
  if (!workerLog) romeSide.push("the Worker's log (the environment gives no logs control for it)");
  else {
    const hits = workerLog.filter((l) => holds(l).length);
    evidence.workerLog = { lines: workerLog.length, holdingAToken: hits.length };
    if (hits.length) problems.push(`the Worker's log holds a Slack token on ${hits.length} line(s)`);
  }
  // Stored or logged by the instance: the environment's find_secret control,
  // which counts, per place, where a value is found.
  for (const inst of ctx.instances) {
    const target = inst.findSecret;
    if (!target) {
      romeSide.push(`a token stored or logged on ${inst.name} (no find_secret control)`);
      continue;
    }
    const found = await inst.findSecretCounts(ofApp.map((t) => t.value)).catch((e) => ({ error: e.message }));
    evidence[`found_${inst.name}`] = found;
    const read = found?.error ? null : secretTotal(found);
    if (!read) romeSide.push(`a token stored or logged on ${inst.name} (find_secret ${found?.error ? `failed: ${found.error}` : "answered no count"})`);
    else if (read.total) problems.push(`a Slack token is stored or logged on ${inst.name}: ${read.total} time(s), in ${read.places.join(", ") || "places it does not name"}`);
  }
  // 10 calls from the instance bound to B, in workspace A: none reaches Slack.
  const since = await ctx.slack.seq();
  const answers = [];
  const dmA = (await ctx.slack.state()).workspaces.find((w) => w.id === ctx.wsA.id)?.members?.find((m) => m.id === ctx.wsA.guardian)?.im_channel;
  for (let i = 1; i <= 10; i++) {
    const method = i % 2 ? "chat.postMessage" : "conversations.history";
    const args = i % 2 ? { channel: dmA, text: `From the wrong instance (${code("W15", i)})` } : { channel: dmA };
    const r = await ctx.b.op("call", { team: ctx.wsA.id, method, args });
    answers.push({ method, status: r.status, error: r.body?.error ?? null });
  }
  const atSlack = (await ctx.slack.calls({ team: ctx.wsA.id, since })).length;
  evidence.crossInstance = { answers, callsAtSlack: atSlack };
  if (atSlack) problems.push(`${atSlack} of 10 calls from the instance bound to B reached Slack in workspace A`);
  const passedThrough = answers.filter((a) => a.status < 400).length;
  if (passedThrough) problems.push(`${passedThrough} of 10 calls from the wrong instance were answered ${answers.find((a) => a.status < 400).status}`);
  return result(
    problems,
    `no Slack token in ${evidence.sentToInstance.answers} answers and ${evidence.sentToInstance.frames} deliveries to the instances${workerLog ? ` or ${workerLog.length} lines of the Worker's log` : ""}; ${atSlack} of 10 calls from the other instance reached Slack`,
    evidence,
    romeSide,
  );
}

export async function r8(ctx) {
  if (!ctx.bound.a || !ctx.bound.b) return { result: "not checked", reason: "the stand-in instances could not be bound" };
  const ws = ctx.wsA;
  const evidence = {};
  const problems = [];
  // Removing the app in Slack: the Worker lets the workspace go within a minute.
  const before = await ctx.slack.seq();
  await ctx.slack.uninstall(ws.id);
  let released = false;
  const until = Date.now() + 60_000;
  while (Date.now() < until && !released) {
    const listed = await ctx.a.op("workspaces");
    released = !(listed.body?.workspaces ?? []).some((w) => w.teamId === ws.id);
    if (!released) await sleep(3000);
  }
  evidence.removal = { releasedWithin60s: released, events: (await ctx.slack.events(before)).map((e) => e.body?.event?.type ?? e.type) };
  if (!released) problems.push("after the app was removed in Slack, the Worker still held workspace A for the first instance after 1 minute");
  // The same sign-in fixes it: the same instance holds A again.
  const again = await ctx.a.op("bind", { team: ws.id, user: ws.guardian });
  const listed = await ctx.a.op("workspaces");
  evidence.repair = { status: again.status, teamId: again.body?.teamId ?? null, holds: (listed.body?.workspaces ?? []).map((w) => w.teamId) };
  if (again.status !== 200 || again.body?.teamId !== ws.id) problems.push(`signing in again answered ${again.status} ${again.body?.error ?? ""}`);
  // Disconnecting: Slack refuses the token, and the workspace is free for another instance.
  const off = await ctx.a.op("disconnect");
  const test = await ctx.slack.authTest(ws.id);
  evidence.disconnect = { status: off.status, released: off.body?.released ?? null, authTest: { ok: test.ok ?? null, error: test.error ?? null, tokenState: test.tokenState } };
  if (off.status !== 200) problems.push(`disconnecting answered ${off.status}`);
  if (test.ok) problems.push("after disconnecting, Slack still takes the workspace's token");
  const other = await ctx.b.op("bind", { team: ws.id, user: ws.guardian });
  evidence.freed = { status: other.status, teamId: other.body?.teamId ?? null, error: other.body?.error ?? null };
  if (other.status !== 200 || other.body?.teamId !== ws.id) problems.push(`after disconnecting, another instance could not connect workspace A (${other.status} ${other.body?.error ?? ""})`);
  return result(
    problems,
    `removal let A go ${released ? "within 1 minute" : "not within 1 minute"}; signing in again bound A to the same instance; disconnecting revoked the token and another instance could connect A`,
    evidence,
    ["Rome marking the connection broken within 1 minute", "the repair reaching the same connected account in Rome"],
  );
}

/** Rules only Rome can show. */
export const romeOnly = {
  R1: "the guardian's sign-in through Rome's Connect and the connection it ends in",
  R2: "R1 from a workspace the team does not own",
  R10: "Connect and the old Slack kinds in Rome",
  R14: "the groups through Rome's connection",
};
