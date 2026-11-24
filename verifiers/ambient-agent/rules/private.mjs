// Rule 7: 20 questions, alternating between direct messages from 3 members
// and shared chats. A direct message's value must be answered in that direct
// message and appear nowhere else. A question with no answer counts against
// the rule, in a direct message or a shared chat.

import { lacks, pace, repeated } from "../lib/pace.mjs";
import { asked, awaitValues, judge } from "../lib/places.mjs";
import { drawValues, echoText, privateText } from "../lib/scenario.mjs";

const QUESTIONS = 20;
const DM_MEMBERS = 3;

export function privateLacks(ctx) {
  if (!ctx.scopes.includes("im:history"))
    return "the app's install lacks im:history, so Slack sends it no direct message (message.im)";
  return (
    lacks(
      "member(s), not the guardian, with a direct message with the app",
      ctx.dmPeople.length,
      DM_MEMBERS,
    ) ?? lacks("shared chat(s) the app is in", ctx.chats.length, 1)
  );
}

async function once(ctx) {
  const dmPeople = ctx.dmPeople.slice(0, DM_MEMBERS);
  const values = drawValues(QUESTIONS);
  const questions = [];
  let posts = [];
  const first = await ctx.slack.seq();
  for (let i = 0; i < QUESTIONS; i++) {
    const waited = await pace(ctx);
    const since = await ctx.slack.seq();
    let q;
    if (i % 2 === 0) {
      const by = dmPeople[(i / 2) % dmPeople.length];
      const r = await ctx.slack.dm(ctx.team, by, privateText(values[i], i / 2));
      q = { dm: true, channel: ctx.dms[by], threadTs: null, ts: r.ts, by, value: values[i] };
    } else {
      const chat = ctx.chats[((i - 1) / 2) % ctx.chats.length];
      const by = chat.people[i % chat.people.length];
      const r = await ctx.slack.mention(ctx.team, by, chat.id, echoText(values[i], i));
      q = { dm: false, channel: chat.id, threadTs: null, ts: r.ts, by, value: values[i] };
    }
    q.waitedForLimitMs = waited;
    questions.push(q);
    await awaitValues(ctx, [q], since, ctx.replyMs + ctx.env.historyLimit.windowMs);
    posts = await ctx.slack.posts({ team: ctx.team, since: first });
    const [j] = judge([q], posts);
    ctx.log(
      `    ${q.dm ? "direct message" : "shared chat"} ${i + 1}: ${j.verdict}, waited ${Math.round(waited / 1000)} s for the limit`,
    );
    if (q.dm && j.verdict !== "answered") break;
    if (!q.dm && j.verdict === "unanswered") break;
  }
  const judged = judge(questions, posts);
  const dms = judged.filter((q) => q.dm);
  const shared = judged.filter((q) => !q.dm);
  const leaked = dms.filter((q) => q.verdict === "misplaced");
  const dmUnanswered = dms.filter((q) => q.verdict === "unanswered");
  const sharedUnanswered = shared.filter((q) => q.verdict === "unanswered");
  const evidence = {
    asked: judged.length,
    planned: QUESTIONS,
    directMessages: {
      asked: dms.length,
      inPlace: dms.length - leaked.length - dmUnanswered.length,
      leaked: leaked.length,
      unanswered: dmUnanswered.length,
    },
    // Where a shared chat's answer landed is rule 5's to score; here it must only be answered.
    sharedChats: {
      asked: shared.length,
      unanswered: sharedUnanswered.length,
      misplacedNotScored: shared.filter((q) => q.verdict === "misplaced").length,
    },
    questions: judged.map((q) => ({
      ...asked(q),
      verdict: q.verdict,
      right: q.right,
      wrong: q.wrong,
      waitedForLimitMs: q.waitedForLimitMs,
    })),
  };
  const pass =
    judged.length === QUESTIONS &&
    !leaked.length &&
    !dmUnanswered.length &&
    !sharedUnanswered.length;
  const parts = [
    `${dms.length - leaked.length - dmUnanswered.length} of ${dms.length} direct messages answered in that direct message only`,
    `${leaked.length} leaked elsewhere`,
    `${dmUnanswered.length} direct message(s) and ${sharedUnanswered.length} shared chat question(s) unanswered`,
  ];
  if (judged.every((q) => q.verdict === "unanswered"))
    parts.push("the agent did not answer a member");
  if (judged.length < QUESTIONS)
    parts.push(
      `stopped after ${judged.length} of ${QUESTIONS} questions, as the bar could no longer be met`,
    );
  return { result: pass ? "pass" : "fail", reason: parts.join("; "), evidence };
}

/** Rule 7, three runs. */
export async function directMessages(ctx) {
  const missing = privateLacks(ctx);
  if (missing) return { result: "not checked", reason: missing };
  return repeated(ctx, once);
}
