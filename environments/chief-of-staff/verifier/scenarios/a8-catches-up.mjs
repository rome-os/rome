import { agentMessagesSince } from "../lib/checks.mjs";
import { loadHearing, recallCheck, sleep } from "../lib/hearing.mjs";
import { check, ruleResult } from "../lib/scenario.mjs";

/** How long Rome stays stopped while the team talks, unless the run's waits say otherwise. */
export const OFFLINE_MS = 60 * 60 * 1000;

export default {
  rule: "A8",
  title: "Catches up",
  phase: 2,
  async run(ctx) {
    const { env } = ctx;
    const { a8Facts, a8Settled } = loadHearing();
    const offlineMs = ctx.waits.offlineMs ?? OFFLINE_MS;
    // The settled exchange: a mention that another member answers while Rome is down.
    const talk = [
      { ...a8Settled.question, chat: a8Settled.chat, mention: true },
      { ...a8Settled.answer, chat: a8Settled.chat },
      { ...a8Settled.thanks, chat: a8Settled.chat },
      ...a8Facts,
    ];
    const step = Math.floor(offlineMs / (talk.length + 1));
    const ids = [];
    const stoppedAt = Date.now();
    await env.rome("stop");
    try {
      for (const m of talk) {
        await sleep(step);
        ids.push(
          await env.post({
            as: m.as,
            chat: m.chat,
            mentionAgent: Boolean(m.mention),
            text: m.text,
          }),
        );
      }
      await sleep(Math.max(0, offlineMs - (Date.now() - stoppedAt)));
    } finally {
      await env.rome("start");
    }
    // Give the agent the reply wait to catch up before anything else is said to it.
    await sleep(ctx.waits.replyMs);
    const settledChats = [a8Settled.chat];
    const replies = await agentMessagesSince(env, { chats: settledChats, since: ids[0] });
    const settled = {
      ...check(
        "replies to no message the conversation already settled",
        replies.length === 0 ? "pass" : "fail",
        replies.length === 0
          ? `no agent message in ${settledChats.join(", ")} after Rome started`
          : `replied after Rome started: ${replies.map((m) => m.id).join(", ")}`,
        [ids[0], ids[1], ...replies.map((m) => m.id)],
      ),
      quote: replies.map((m) => m.text).join("\n---\n") || undefined,
    };
    const recall = await recallCheck(
      ctx,
      a8Facts,
      ids.slice(3),
      `recalls what was said during ${Math.round(offlineMs / 60000)} min offline`,
    );
    return ruleResult([settled, recall]);
  },
};
