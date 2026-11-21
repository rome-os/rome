// R5 (mentions). Rule text: rule set v4 in the planner's rules.md. Checked at
// the edges: each mention is on record in Rome, and a send to a thread lands
// in that thread at the fake.

import { ask, code } from "../lib/codes.mjs";
import { waitFor } from "../lib/http.mjs";
import { onRecord } from "../lib/record.mjs";

/** Waits for a post in thread `threadTs` of `channel` after `since`, carrying `tag` when given. */
async function postInThread(ctx, ws, channel, threadTs, since, tag) {
  return (
    (await waitFor(
      async () =>
        (await ctx.slack.posts({ team: ws.id, channel, since })).find(
          (p) => p.threadTs === threadTs && (!tag || p.text?.includes(tag)),
        ),
      { timeoutMs: ctx.env.timeouts.replySeconds * 1000 },
    )) ?? null
  );
}

export async function r5(ctx) {
  if (!ctx.bound.a) return { result: "not checked", reason: "R1 made no connection to build on." };
  // Slack's pace on history reads is not R5's subject: off while it runs, so
  // a thread read behind an answer holds nothing up.
  const limitWas = (await ctx.slack.state()).history_limit?.on ?? true;
  await ctx.slack.config({ history_limit: false });
  try {
    return await mentions(ctx);
  } finally {
    await ctx.slack.config({ history_limit: limitWas });
  }
}

async function mentions(ctx) {
  const ws = ctx.wsA;
  const inst = ctx.a;
  const w = (await ctx.slack.state()).workspaces.find((x) => x.id === ws.id);
  const member = w?.members?.find((m) => m.id !== ws.guardian && !m.is_bot && !m.is_restricted)?.id ?? ws.guardian;

  // 10 mentions from the guardian: 5 at the top of the group, 5 each in a
  // thread a member started.
  const mentions = [];
  for (let i = 1; i <= 10; i++) {
    const tag = code("R5", i);
    let root = null;
    if (i > 5) root = await ctx.slack.groupMessage(ws.id, member, `A thread for the mention ${tag}.`);
    const since = await ctx.slack.seq();
    const sent = await ctx.slack.mention(ws.id, ws.guardian, ask(tag), root?.channel, root ? { thread_ts: root.ts } : {});
    mentions.push({ tag, since, channel: sent.channel, ts: sent.ts, thread: root?.ts ?? null, eventId: sent.eventId });
  }
  const group = mentions[0].channel;
  // The group and each thread, which Chats may keep as a chat of its own.
  const chats = [group, ...mentions.filter((m) => m.thread).map((m) => `${group}:${m.thread}`)];
  const got = await onRecord(inst, chats, ctx.bound.a, mentions.map((m) => m.tag), ctx.env.timeouts.replySeconds * 2 * 1000);

  // Its thread, where the record says one: a reply in a thread names the
  // thread's root, a top message itself or nothing.
  const threadFacts = got.rows.some((r) => r.thread !== undefined && r.thread !== null)
    ? mentions.map((m) => {
        const row = got.rows.find((r) => r.text.includes(m.tag));
        const want = m.thread;
        const has = row?.thread ?? null;
        const ok = want ? has === want : has === null || has === m.ts;
        return { tag: m.tag, thread: want, recorded: has, ok };
      })
    : null;

  // A send to a thread lands in that thread: through the port when there is
  // one, else Rome's own post after each threaded mention.
  const threaded = mentions.filter((m) => m.thread);
  const sends = [];
  for (const m of threaded) {
    if (inst.hasPort) {
      const tag = code("R5S", sends.length + 1);
      const since = await ctx.slack.seq();
      const answered = await inst.port("send", { chat: group, thread: m.thread, text: `Into the thread (${tag})` });
      const post = await postInThread(ctx, ws, group, m.thread, since, tag);
      const anywhere = post ? null : (await ctx.slack.posts({ team: ws.id, since })).find((p) => p.text?.includes(tag));
      sends.push({ thread: m.thread, how: "port send", answered, landed: Boolean(post), elsewhere: anywhere ? { channel: anywhere.channel, threadTs: anywhere.threadTs ?? null } : null });
    } else {
      const post = await postInThread(ctx, ws, group, m.thread, m.since);
      sends.push({ thread: m.thread, how: "Rome's post after the mention (no port)", landed: Boolean(post) });
    }
  }

  const evidence = {
    group,
    mentions: mentions.map(({ tag, eventId, ts, thread }) => ({ tag, eventId, ts, thread })),
    notOnRecord: got.missing,
    threadFacts: threadFacts ?? "covered by the product's tests (the record read shows no thread); not run here",
    mentionedFact: "covered by the product's tests (Chats keeps no mention fact to read); not run here",
    sendsToThreads: sends,
  };
  const problems = [];
  if (got.missing.length) problems.push(`${got.missing.length} of 10 mentions were not on record (${got.missing.join(", ")})`);
  const wrongThread = threadFacts?.filter((f) => !f.ok) ?? [];
  if (wrongThread.length) problems.push(`${wrongThread.length} mention(s) on record with the wrong thread`);
  const missed = sends.filter((s) => !s.landed);
  if (missed.length) problems.push(`${missed.length} of ${sends.length} sends to a thread did not land in it`);
  const said = `${10 - got.missing.length} of 10 mentions on record; ${sends.length - missed.length} of ${sends.length} sends landed in their thread (${sends[0]?.how ?? "none"})`;
  if (problems.length) return { result: "fail", reason: `${said}. ${problems.join("; ")}`, evidence };
  return {
    result: "pass",
    reason: `${said}. ${threadFacts ? "Each is on record with its thread" : "The thread and mentioned facts are covered by the product's tests, not run here"}.`,
    evidence,
  };
}
