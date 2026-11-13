import { secondsBetween } from "../lib/checks.mjs";
import { ask, check, ruleResult } from "../lib/scenario.mjs";

const A1_LIMIT_SECONDS = 120;

/**
 * Mentions the agent once at the top of every chat named for it, and once inside a thread,
 * and records where and when it replied. A5 reads the same replies, so this runs once per
 * run and is shared through `ctx.memo.A1`.
 */
export async function collectMentions(ctx) {
  if (ctx.memo.A1) return ctx.memo.A1;
  const { env, team } = ctx;
  const chats = Object.keys(team.chats).filter((c) => team.chats[c].namedForAgent);
  const mentions = [];
  for (const chat of chats) {
    const as = team.chats[chat].readers[0];
    const text = "Quick check: who coordinates the Orkney pier installs?";
    const { questionId, reply } = await ask(ctx, {
      as,
      chat,
      text,
      watch: chats,
      timeoutMs: ctx.waits.a1Ms,
    });
    mentions.push({ chat, thread: null, questionId, reply });
  }
  const as = team.members[0].account;
  const root = await env.post({
    as,
    chat: "general",
    text: "Thread for planning the week 49 pier installs.",
  });
  const { questionId, reply } = await ask(ctx, {
    as,
    chat: "general",
    thread: root,
    text: "Who owns the Orkney pier install goal?",
    watch: chats,
    timeoutMs: ctx.waits.a1Ms,
  });
  mentions.push({ chat: "general", thread: root, questionId, reply });

  for (const mention of mentions) {
    const said = (await env.read({ chat: mention.chat })).find((m) => m.id === mention.questionId);
    mention.time = said?.time;
  }
  ctx.memo.A1 = mentions;
  return mentions;
}

function where(m) {
  return m.thread ? `${m.chat} thread ${m.thread}` : m.chat;
}

export default {
  rule: "A1",
  title: "Present",
  phase: 1,
  async run(ctx) {
    const mentions = await collectMentions(ctx);
    return ruleResult(
      mentions.map((m) => {
        const evidence = [m.questionId, m.reply?.id];
        if (!m.reply) return check(where(m), "fail", "no reply within the wait", evidence);
        if (!m.time)
          return check(where(m), "not_checked", "could not read the mention's time", evidence);
        const seconds = secondsBetween(m.time, m.reply.time);
        return seconds <= A1_LIMIT_SECONDS
          ? check(where(m), "pass", `replied in ${seconds} s`, evidence)
          : check(
              where(m),
              "fail",
              `replied in ${seconds} s, over ${A1_LIMIT_SECONDS} s`,
              evidence,
            );
      }),
    );
  },
};
