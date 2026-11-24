// Rule 8: a mention asks for work the Concierge hands to another agent, and
// 5 mentions arrive in other chats while it runs. The result must land in the
// chat and thread that asked. The hand-off is read from the instance's log
// (a `chat_start` tool run), not from the reply.

import { run } from "../lib/control.mjs";
import { lacks, pace, repeated } from "../lib/pace.mjs";
import { asked, awaitValues, judge, tally } from "../lib/places.mjs";
import { drawValues, echoText, fillers, workRequest } from "../lib/scenario.mjs";

const ROUNDS = 10;
const OTHERS = 5;

export function workLacks(ctx) {
  if (!ctx.env.instance.logs)
    return "env.json names no logs control for the instance, so the hand-off cannot be read from its records";
  return lacks("shared chat(s) the app is in", ctx.chats.length, 2);
}

/**
 * The instance's hand-offs since `since`: each log line of a Concierge tool
 * run of `chat_start`, with its time. Log lines may carry a prefix before
 * their JSON, as `docker compose logs` writes them.
 */
export async function handOffs(ctx, since) {
  const r = await run(ctx.env.instance.logs, ["--since", since], { timeoutMs: 120_000 });
  const out = [];
  for (const line of r.stdout.split("\n")) {
    const at = line.indexOf("{");
    if (at < 0) continue;
    let entry;
    try {
      entry = JSON.parse(line.slice(at));
    } catch {
      continue;
    }
    if (entry.message === "executing Rome tool" && entry.data?.tool === "chat_start")
      out.push({ at: entry.timestamp ?? entry.at, component: entry.component });
  }
  return { records: out, exit: r.code };
}

async function once(ctx) {
  const ruleStart = new Date().toISOString();
  const rounds = [];
  for (let i = 0; i < ROUNDS; i++) {
    const home = ctx.chats[i % ctx.chats.length];
    const others = ctx.chats.filter((c) => c.id !== home.id);
    const by = home.people[i % home.people.length];
    let threadTs = null;
    if (i % 2 === 1)
      threadTs = (await ctx.slack.groupMessage(ctx.team, by, home.id, fillers(1)[0])).ts;
    const work = workRequest();
    const waited = await pace(ctx);
    const since = await ctx.slack.seq();
    const t0 = new Date();
    const r = await ctx.slack.mention(ctx.team, by, home.id, work.text, threadTs ?? undefined);
    const q = { channel: home.id, threadTs, ts: r.ts, by, value: work };
    // The others arrive while the work runs: after the agent has heard the
    // request, before its result is due.
    await ctx.sleep(ctx.sideDelayMs);
    const values = drawValues(OTHERS);
    const items = values.map((value, k) => {
      const chat = others[k % others.length];
      return {
        kind: "mention",
        user: chat.people[(i + k) % chat.people.length],
        channel: chat.id,
        text: echoText(value, k),
      };
    });
    const sideAt = await ctx.slack.seq();
    const results = await ctx.slack.batch(ctx.team, items);
    const side = items.map((it, k) => ({
      channel: it.channel,
      threadTs: null,
      ts: results[k].ts,
      by: it.user,
      value: values[k],
    }));
    const posts = await awaitValues(ctx, [q], since, ctx.workMs);
    const [jq] = judge([q], posts);
    const result = posts.find((p) => jq.right.some((x) => x.ts === p.ts));
    const round = {
      round: i + 1,
      thread: threadTs !== null,
      from: t0.toISOString(),
      to: new Date().toISOString(),
      waitedForLimitMs: waited,
      seconds: Math.round((Date.now() - t0) / 1000),
      ask: { ...asked(q), verdict: jq.verdict, right: jq.right, wrong: jq.wrong },
      // Whether the other mentions went out before the result landed, so they arrived while it ran.
      othersBeforeResult: result ? result.seq > sideAt : null,
      others: { ...tally(judge(side, posts)), notScored: true },
      repliesInPlace: posts
        .filter((p) => p.channel === q.channel)
        .map((p) => ({ ts: p.ts, threadTs: p.threadTs ?? null, text: p.text })),
    };
    rounds.push(round);
    ctx.log(
      `    round ${i + 1}${round.thread ? " (thread)" : ""}: result ${jq.verdict}, waited ${Math.round(waited / 1000)} s for the limit`,
    );
    if (jq.verdict !== "answered") break;
  }
  const logs = await handOffs(ctx, ruleStart);
  for (const r of rounds) {
    r.handOffs = logs.records.filter((x) => x.at >= r.from && x.at <= r.to).map((x) => x.at);
    r.handedOff = r.handOffs.length > 0;
    r.ok = r.ask.verdict === "answered" && r.handedOff;
  }
  const good = rounds.filter((r) => r.ok).length;
  const evidence = { rounds, logsExit: logs.exit };
  if (good === ROUNDS)
    return {
      result: "pass",
      reason: `${ROUNDS} of ${ROUNDS} results landed in the chat and thread that asked, each after a hand-off`,
      evidence,
    };
  const count = (pred) => rounds.filter(pred).length;
  const parts = [`${good} of ${ROUNDS} results in place after a hand-off`];
  const misplaced = count((r) => r.ask.verdict === "misplaced");
  const unanswered = count((r) => r.ask.verdict === "unanswered");
  const notHanded = count((r) => !r.handedOff);
  if (misplaced) parts.push(`${misplaced} result(s) landed elsewhere`);
  if (unanswered)
    parts.push(
      `${unanswered} result(s) never came${rounds.every((r) => !r.repliesInPlace.length) ? " and the agent did not answer a member's mention" : ""}`,
    );
  if (notHanded) parts.push(`${notHanded} round(s) with no hand-off in the instance's log`);
  if (rounds.length < ROUNDS)
    parts.push(`stopped after round ${rounds.length}, as the bar could no longer be met`);
  return { result: "fail", reason: parts.join("; "), evidence };
}

/** Rule 8, three runs. */
export async function workReturns(ctx) {
  const missing = workLacks(ctx);
  if (missing) return { result: "not checked", reason: missing };
  return repeated(ctx, once);
}
