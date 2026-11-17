import { agentMessagesSince } from "../lib/checks.mjs";
import { loadHearing, recallCheck, sleep } from "../lib/hearing.mjs";
import { check, ruleResult } from "../lib/scenario.mjs";

/**
 * Waits until every message in `ids` reads back from its chat, so Rome starts only after
 * Discord holds all of them. Resolves to whether they all arrived within `timeoutMs`.
 */
async function delivered(env, said, ids, { timeoutMs, pollMs }) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const found = new Set();
    for (const chat of new Set(said.map((m) => m.chat)))
      for (const m of await env.read({ chat, since: ids[0] })) found.add(m.id);
    // The first id is the `since` bound, so it is never in the read; it was posted first.
    if (ids.slice(1).every((id) => found.has(id))) return true;
    if (Date.now() >= deadline) return false;
    await sleep(pollMs);
  }
}

/**
 * A8's property (planner, 2026-11-17): a message said while Rome was stopped still reaches the
 * agent once Rome starts. How long Rome stays stopped does not matter, so the run stops it
 * only until Discord shows the messages delivered.
 */
export default {
  rule: "A8",
  title: "Catches up",
  // Ouou (2026-11-17) deferred handling a restart to a later phase; the code stays.
  phase: 3,
  movedFrom: 2,
  async run(ctx) {
    const { env } = ctx;
    const { a8Facts, a8Settled } = loadHearing();
    // The settled exchange: a mention that another member answers while Rome is down.
    const talk = [
      { ...a8Settled.question, chat: a8Settled.chat, mention: true },
      { ...a8Settled.answer, chat: a8Settled.chat },
      { ...a8Settled.thanks, chat: a8Settled.chat },
      ...a8Facts,
    ];
    const ids = [];
    const stoppedAt = Date.now();
    let arrived;
    await env.rome("stop");
    try {
      for (const m of talk) {
        ids.push(
          await env.post({
            as: m.as,
            chat: m.chat,
            mentionAgent: Boolean(m.mention),
            text: m.text,
          }),
        );
        if (ctx.waits.gapMs) await sleep(ctx.waits.gapMs);
      }
      arrived = await delivered(env, talk, ids, {
        timeoutMs: ctx.waits.a1Ms,
        pollMs: ctx.waits.pollMs,
      });
    } finally {
      await env.rome("start");
    }
    const offlineSeconds = Math.round((Date.now() - stoppedAt) / 1000);
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
      `recalls the ${a8Facts.length} facts said while Rome was stopped`,
    );
    return {
      ...ruleResult([settled, recall]),
      info: [
        `Short form: Rome was stopped ${offlineSeconds} s, until Discord ${arrived ? "showed every message delivered" : "had not shown every message within the A1 wait"}. The length of the stop is not part of the rule (planner, 2026-11-17)`,
      ],
    };
  },
};
