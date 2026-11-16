import { agentMessagesSince } from "../lib/checks.mjs";
import { loadHearing, sleep } from "../lib/hearing.mjs";
import { ask, check, ruleResult } from "../lib/scenario.mjs";

/** Whether a reply answers one of the cases, by their words, rather than only declining. */
export function answersACase(text, cases) {
  const lower = String(text ?? "").toLowerCase();
  return cases.some((c) => c.tokens.some((t) => lower.includes(t.toLowerCase())));
}

export default {
  rule: "A7",
  title: "Takes a hint",
  phase: 2,
  async run(ctx) {
    const { env } = ctx;
    const { chat, hint, cases, lift, after } = loadHearing().a7;
    // The instruction itself may be acknowledged; only what follows it counts.
    const told = await ask(ctx, { as: hint.as, chat, text: hint.text, statement: true });
    const caseIds = [];
    for (const c of cases) {
      caseIds.push(await env.post({ as: c.as, chat, mentionAgent: true, text: c.text }));
      if (ctx.waits.gapMs) await sleep(ctx.waits.gapMs);
    }
    await sleep(ctx.waits.a1Ms);
    const replies = await agentMessagesSince(env, { chats: [chat], since: caseIds[0] });
    const answered = replies.filter((m) => answersACase(m.text, cases));
    const declined = replies.filter((m) => !answersACase(m.text, cases));
    if (ctx.answered) ctx.answered.sent += cases.length;

    const lifted = await ask(ctx, { as: lift.as, chat, text: lift.text, statement: true });
    const later = await ask(ctx, { as: after.as, chat, text: after.text });
    const laterAnswers = Boolean(later.reply) && answersACase(later.reply.text, [after]);

    const list = (ms) => ms.map((m) => m.id).join(", ");
    return {
      ...ruleResult([
        {
          ...check(
            `no reply to ${cases.length} mentions on the topic it was told to stay out of`,
            replies.length === 0 ? "pass" : "fail",
            replies.length === 0
              ? "no replies"
              : `${replies.length} replies: ${answered.length} answering (${list(answered) || "none"}), ${declined.length} declining (${list(declined) || "none"})`,
            [told.questionId, told.reply?.id, ...caseIds, ...replies.map((m) => m.id)],
          ),
          quote: replies.map((m) => m.text).join("\n---\n") || undefined,
        },
        {
          ...check(
            "answers on the topic once told it may",
            laterAnswers ? "pass" : "fail",
            later.reply
              ? laterAnswers
                ? `answered ${later.reply.id}`
                : `replied ${later.reply.id} without answering`
              : "no reply within the reply wait",
            [lifted.questionId, lifted.reply?.id, later.questionId, later.reply?.id],
          ),
          quote: later.reply?.text,
        },
      ]),
      replies: { answered: answered.length, declined: declined.length },
    };
  },
};
