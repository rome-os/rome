// R9 (send and read, nothing else). Rule text: rule set v4 in the planner's
// rules.md. Checked at the edges: what the connection's own port answers
// (the environment's `port` control), and every call the fake Slack saw.

import { code } from "../lib/codes.mjs";
import { pacedRead, refused, why } from "../lib/port.mjs";
import { waitFor } from "../lib/http.mjs";

/** What Rome's app may call at Slack: send, read, and keeping the connection. */
export const ALLOWED = new Set([
  // send
  "chat.postMessage",
  // read
  "conversations.history",
  "conversations.replies",
  "conversations.list",
  "conversations.info",
  "users.conversations",
  // the connection itself: its token, names, direct messages, revoke
  "auth.test",
  "auth.revoke",
  "oauth.v2.access",
  "users.info",
  "conversations.open",
]);

/** Methods R9 asks the port for, each of which it must refuse with no call at Slack. */
export const OTHERS = [
  { method: "search.messages", args: { query: "picnic" } },
  { method: "chat.delete", args: { ts: "1.000001" } },
  { method: "conversations.invite", args: { users: "U0" } },
  { method: "users.list", args: {} },
  { method: "reactions.add", args: { name: "wave", timestamp: "1.000001" } },
];

/**
 * Every Web API call the fake saw after `since`, judged: a method outside
 * {@link ALLOWED}, or a call with a user token (a guardian's own).
 */
export async function auditCalls(ctx, since) {
  const calls = await ctx.slack.calls({ since });
  const byMethod = {};
  for (const c of calls) byMethod[c.method] = (byMethod[c.method] ?? 0) + 1;
  return {
    calls: calls.length,
    byMethod,
    outside: calls.filter((c) => !ALLOWED.has(c.method)).map((c) => ({ seq: c.seq, method: c.method, team: c.teamId, tokenKind: c.tokenKind })),
    userToken: calls.filter((c) => c.tokenKind === "user").map((c) => ({ seq: c.seq, method: c.method, team: c.teamId })),
  };
}


export async function r9(ctx) {
  if (!ctx.bound.a) return { result: "not checked", reason: "R1 made no connection to build on." };
  const ws = ctx.wsA;
  const inst = ctx.a;
  const evidence = {};
  const problems = [];
  const unchecked = [];

  if (inst.hasPort) {
    const dm = ctx.fromA?.channel ?? (await ctx.slack.state()).workspaces.find((x) => x.id === ws.id)?.members?.find((m) => m.id === ws.guardian)?.im_channel;
    // Send: a tagged text arrives in the chat, from the app's bot.
    const tag = code("R9S", 0);
    const since = await ctx.slack.seq();
    const sent = await inst.port("send", { chat: dm, text: `Through the port (${tag})` });
    const post = await waitFor(
      async () => (await ctx.slack.posts({ team: ws.id, channel: dm, since })).find((p) => p.text?.includes(tag)),
      { timeoutMs: ctx.env.timeouts.replySeconds * 1000 },
    );
    evidence.send = { chat: dm, answered: sent, arrived: Boolean(post), tokenKind: post?.tokenKind ?? null };
    if (!post) problems.push("a send through the port did not arrive");
    else if (post.tokenKind !== "bot") problems.push(`a send through the port went out with a ${post.tokenKind} token`);

    // Read: the chat's recent messages, read at Slack, hold the one just sent.
    const readSince = await ctx.slack.seq();
    const paced = await pacedRead(ctx, inst, ws.id, "read", { chat: dm });
    const read = paced.answer;
    const history = (await ctx.slack.calls({ team: ws.id, method: "conversations.history", since: readSince })).length;
    const holds = JSON.stringify(read ?? "").includes(tag);
    evidence.read = { chat: dm, waitedSeconds: paced.waitedSeconds, retriedAfter: paced.firstRefusal, holdsTheSend: holds, historyCalls: history, refused: refused(read) ? why(read) : null };
    if (refused(read)) problems.push(`the port refused a read of a direct message: ${why(read)}`);
    else if (!holds) problems.push("a read through the port did not hold the message just sent");

    // Anything else: refused, with no call at Slack.
    evidence.others = [];
    for (const o of OTHERS) {
      const before = await ctx.slack.seq();
      const answer = await inst.port("call", o);
      const made = (await ctx.slack.calls({ method: o.method, since: before })).length;
      evidence.others.push({ method: o.method, refused: refused(answer), why: refused(answer) ? why(answer) : null, callsAtSlack: made });
      if (!refused(answer)) problems.push(`the port did not refuse ${o.method}`);
      if (made) problems.push(`${o.method} reached Slack ${made} time(s)`);
    }
  } else unchecked.push("send, read and refusal through the connection's port: the environment gives no port control");

  // Every call so far: only allowed methods, never a user token.
  const audit = await auditCalls(ctx, ctx.runSince ?? 0);
  evidence.audit = audit;
  if (audit.outside.length)
    problems.push(`${audit.outside.length} call(s) at Slack outside send and read (${[...new Set(audit.outside.map((c) => c.method))].join(", ")})`);
  if (audit.userToken.length) problems.push(`${audit.userToken.length} call(s) at Slack used a user token`);

  const said = `${audit.calls} calls at Slack this run, ${audit.outside.length} outside send and read, ${audit.userToken.length} with a user token` +
    (evidence.others ? `; the port refused ${evidence.others.filter((o) => o.refused).length} of ${OTHERS.length} other methods` : "");
  if (problems.length) return { result: "fail", reason: `${said}. ${problems.join("; ")}`, evidence };
  if (unchecked.length) return { result: "not checked", reason: `${said}. Not checked: ${unchecked.join("; ")}`, evidence };
  return {
    result: "pass",
    reason: `${said}. A send through the port arrived from the bot; a read held it; ${OTHERS.map((o) => o.method).join(", ")} were refused with no call at Slack.`,
    evidence,
  };
}
