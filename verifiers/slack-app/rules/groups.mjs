// R14 (groups). Rule text: rule set v4 in the planner's rules.md. Checked at
// the edges: what the connection's port answers about the groups (the
// environment's `port` control), what the fake Slack saw, and what Rome has
// on record.

import { code } from "../lib/codes.mjs";
import { refused, why } from "../lib/port.mjs";
import { phase, sleep, waitFor } from "../lib/http.mjs";
import { dmOnRecord, onRecord } from "../lib/record.mjs";
import { connectAs } from "./connect.mjs";

// The bot scopes a workspace connected before the group permissions holds.
export const OLD_SCOPES = "app_mentions:read,chat:write,im:history,im:read,im:write,users:read";

// What the port's refusal says when the app needs approving again.
const REAPPROVE = /approv/i;

const text = (a) => JSON.stringify(a ?? "");

/** The port's operations on the groups of workspace A. */
async function throughPort(ctx, g, member) {
  const ws = ctx.wsA;
  const inst = ctx.a;
  const ops = [];
  const op = (name, ok, why, extra = {}) => ops.push({ op: name, result: ok ? "pass" : "fail", why, ...extra });

  phase("R14: list groups");
  const groups = await inst.port("groups", {});
  const ids = text(groups);
  op("list groups", !refused(groups) && ids.includes(g.general) && ids.includes(g.news) && !ids.includes(g.quiet),
    refused(groups) ? `refused: ${why(groups)}` : `listed #general ${ids.includes(g.general) ? "yes" : "no"}, #news ${ids.includes(g.news) ? "yes" : "no"}, #quiet ${ids.includes(g.quiet) ? "yes (it is not in it)" : "no"}`);

  phase("R14: read #news");
  // Said in #news with no mention, so only Slack's history holds it.
  const said = `The bakery van parks by the fountain (${code("R14N", 0)}).`;
  await ctx.slack.groupMessage(ws.id, member, said, g.news);
  const read = await inst.port("read", { chat: g.news });
  op("read #news", !refused(read) && text(read).includes(code("R14N", 0)), refused(read) ? `refused: ${why(read)}` : text(read).includes(code("R14N", 0)) ? "held the message said there" : "did not hold the message said there");

  phase("R14: read a thread in #news");
  const root = await ctx.slack.groupMessage(ws.id, member, `Plans for the picnic (${code("R14T", 0)}).`, g.news);
  await ctx.slack.groupMessage(ws.id, ws.guardian, `The blanket is in the van (${code("R14T", 1)}).`, g.news, { thread_ts: root.ts });
  const thread = await inst.port("thread", { chat: g.news, ts: root.ts });
  op("read a thread", !refused(thread) && text(thread).includes(code("R14T", 1)), refused(thread) ? `refused: ${why(thread)}` : text(thread).includes(code("R14T", 1)) ? "held the reply in the thread" : "did not hold the reply in the thread");

  phase("R14: send to #news");
  const tag = code("R14S", 0);
  const since = await ctx.slack.seq();
  const sent = await inst.port("send", { chat: g.news, text: `For the group (${tag})` });
  const post = await waitFor(
    async () => (await ctx.slack.posts({ team: ws.id, channel: g.news, since })).find((p) => p.text?.includes(tag)),
    { timeoutMs: ctx.env.timeouts.replySeconds * 1000 },
  );
  op("send to #news", Boolean(post) && post.tokenKind === "bot", post ? `arrived (${post.tokenKind} token)` : `did not arrive (${text(sent).slice(0, 120)})`);

  phase("R14: nothing of #quiet");
  const quietSaid = `The marmalade jars are in the cellar (${code("R14Q", 0)}).`;
  await ctx.slack.groupMessage(ws.id, member, quietSaid, g.quiet);
  const quiet = await inst.port("read", { chat: g.quiet });
  const quietSince = await ctx.slack.seq();
  const quietSend = await inst.port("send", { chat: g.quiet, text: `Into quiet (${code("R14Q", 1)})` });
  await sleep(ctx.env.timeouts.settleSeconds * 1000);
  const quietPosts = (await ctx.slack.posts({ team: ws.id, channel: g.quiet, since: quietSince })).length;
  op("read #quiet shows nothing", !text(quiet).includes(code("R14Q", 0)), text(quiet).includes(code("R14Q", 0)) ? "the read showed #quiet's message" : refused(quiet) ? `refused: ${why(quiet)}` : "nothing of #quiet");
  op("send to #quiet does not land", quietPosts === 0, quietPosts ? `${quietPosts} post(s) landed in #quiet` : refused(quietSend) ? `refused: ${why(quietSend)}` : "nothing landed");
  return ops;
}

/** What Rome hears in the groups of workspace A: mentions, never plain messages. */
async function hearsOnly(ctx, g, member) {
  const ws = ctx.wsA;
  const ops = [];
  phase("R14: hears only mentions");
  // Sent as events too, as Slack would if the app took group messages: the
  // connection must still keep only the mention.
  const plain = code("R14P", 0);
  const outside = code("R14P", 1);
  const mention = code("R14M", 0);
  await ctx.slack.groupMessage(ws.id, member, `Just chatting here (${plain}).`, g.news, { send_event: true });
  await ctx.slack.groupMessage(ws.id, member, `Just chatting in quiet (${outside}).`, g.quiet, { send_event: true });
  await ctx.slack.mention(ws.id, ws.guardian, `Are you there? (${mention})`, g.news);
  const got = await onRecord(ctx.a, g.news, ctx.bound.a, [mention], ctx.env.timeouts.replySeconds * 1000);
  await sleep(ctx.env.timeouts.settleSeconds * 1000);
  const news = await ctx.a.recordedIn(g.news, { connection: ctx.bound.a, noneIfMissing: true });
  const quiet = await ctx.a.recordedIn(g.quiet, { connection: ctx.bound.a, noneIfMissing: true });
  const heardPlain = news.some((t) => t.includes(plain));
  const heardQuiet = quiet.some((t) => t.includes(outside));
  ops.push({ op: "a mention in a group is on record", result: got.missing.length ? "fail" : "pass", why: got.missing.length ? "not on record" : "on record" });
  ops.push({ op: "a plain group message is not heard", result: heardPlain ? "fail" : "pass", why: heardPlain ? "on record" : "not on record" });
  ops.push({ op: "nothing of a group it is not in is heard", result: heardQuiet ? "fail" : "pass", why: heardQuiet ? "#quiet's message on record" : "not on record" });
  return ops;
}

/**
 * Workspace B on the second instance, signed in again under the scopes from
 * before the group permissions: direct messages and mentions still reach
 * Rome, and its port refuses group work, asking to approve the app again.
 */
async function oldPermissions(ctx) {
  const ws = ctx.wsB;
  const inst = ctx.b;
  const ops = [];
  const evidence = {};
  if (!ctx.bound.b) return { ops: [{ op: "old permissions", result: "not checked", why: "the second instance holds no connection to workspace B" }], evidence };
  try {
    await ctx.slack.grantLimit(ws.id, OLD_SCOPES);
  } catch (err) {
    return { ops: [{ op: "old permissions", result: "not checked", why: `the fake sets no grant limit: ${err.message}` }], evidence };
  }
  try {
    const walk = await connectAs(ctx, inst, ws).catch((e) => ({ outcome: "stuck", reason: e.message }));
    if (typeof walk.connectionId === "string") ctx.bound.b = walk.connectionId;
    const w = (await ctx.slack.state()).workspaces.find((x) => x.id === ws.id);
    evidence.signIn = { outcome: walk.outcome, reason: walk.reason ?? null, scopes: w?.scopes ?? null };
    if (walk.outcome !== "connected" || (w?.scopes ?? []).includes("channels:history"))
      return {
        ops: [{ op: "old permissions", result: "not checked", why: walk.outcome !== "connected" ? `the sign-in under the old scopes ended ${walk.outcome}` : "the grant limit did not hold" }],
        evidence,
      };
    const general = w.groups.find((g) => g.name === "general")?.id;

    phase("R14 old permissions: direct message");
    const dm = await dmOnRecord(ctx, inst, ws, ctx.bound.b, "R14D");
    ops.push({ op: "old permissions: a direct message is on record", result: dm.ok ? "pass" : "fail", why: dm.ok ? "on record" : "not on record" });

    phase("R14 old permissions: mention");
    const tag = code("R14OM", 0);
    await ctx.slack.mention(ws.id, ws.guardian, `Hello from the group (${tag})`, general);
    const got = await onRecord(inst, general, ctx.bound.b, [tag], ctx.env.timeouts.replySeconds * 1000);
    ops.push({ op: "old permissions: a mention is on record", result: got.missing.length ? "fail" : "pass", why: got.missing.length ? "not on record" : "on record" });

    phase("R14 old permissions: the port says approve again");
    // The connection says it at its port: a group listing and a group read
    // are refused, telling the guardian to approve the app again.
    if (!inst.hasPort)
      ops.push({ op: "old permissions: group work says approve again", result: "not checked", why: "the environment gives no port control" });
    else
      for (const [name, op, args] of [
        ["a group listing", "groups", {}],
        ["a read of #general", "read", { chat: general }],
      ]) {
        const answer = await inst.port(op, args);
        evidence[op] = answer;
        const says = refused(answer) && REAPPROVE.test(why(answer));
        ops.push({
          op: `old permissions: ${name} is refused, asking to approve again`,
          result: says ? "pass" : "fail",
          why: says ? `refused: ${why(answer)}` : refused(answer) ? `refused without asking to approve again: ${why(answer)}` : `not refused: ${text(answer).slice(0, 120)}`,
        });
      }
  } finally {
    // Approving again: the limit lifted and B signed in again.
    await ctx.slack.grantLimit(ws.id, null).catch(() => {});
    const walk = await connectAs(ctx, inst, ws).catch((e) => ({ outcome: "stuck", reason: e.message }));
    if (typeof walk.connectionId === "string") ctx.bound.b = walk.connectionId;
    evidence.signInAgain = { outcome: walk.outcome, reason: walk.reason ?? null };
  }
  return { ops, evidence };
}

export async function r14(ctx) {
  if (!ctx.bound.a) return { result: "not checked", reason: "R1 made no connection to build on." };
  const ws = ctx.wsA;
  const w = (await ctx.slack.state()).workspaces.find((x) => x.id === ws.id);
  // The product carries the group work when its app asks for group history.
  if (!(w?.scopes ?? []).includes("channels:history"))
    return {
      result: "not checked",
      reason: `the product's app does not ask for group history (workspace A holds ${(w?.scopes ?? []).join(", ") || "no scopes"}), so this commit does not carry the group work`,
      evidence: { scopes: w?.scopes ?? null },
    };
  const group = (name) => w.groups?.find((g) => g.name === name);
  const news = group("news");
  if (!group("general") || !news || !group("quiet"))
    return { result: "not checked", reason: "the fake has no #general, #news and #quiet in workspace A" };
  const g = { general: group("general").id, news: news.id, quiet: group("quiet").id };
  const member = news.members.find((m) => m !== ws.guardian) ?? ws.guardian;

  const unchecked = [];
  const ops = [];
  const limitWas = (await ctx.slack.state()).history_limit?.on ?? true;
  await ctx.slack.config({ history_limit: false });
  let old;
  try {
    if (ctx.a.hasPort) ops.push(...(await throughPort(ctx, g, member)));
    else unchecked.push("list, read, thread read and send through the connection's port: the environment gives no port control");
    ops.push(...(await hearsOnly(ctx, g, member)));
    old = await oldPermissions(ctx);
    ops.push(...old.ops);
  } finally {
    await ctx.slack.config({ history_limit: limitWas });
  }
  const evidence = { groups: g, operations: ops, oldPermissions: old?.evidence ?? null };
  const list = ops.map((o) => `${o.op} ${o.result} (${o.why})`).join("; ");
  if (ops.some((o) => o.result === "fail")) return { result: "fail", reason: list, evidence };
  const notRun = [...unchecked, ...ops.filter((o) => o.result === "not checked").map((o) => `${o.op}: ${o.why}`)];
  if (notRun.length) return { result: "not checked", reason: `${list}. Not checked: ${notRun.join("; ")}`, evidence };
  return { result: "pass", reason: list, evidence };
}
