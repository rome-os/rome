import { agentMessagesSince } from "../lib/checks.mjs";
import { loadHearing, sleep } from "../lib/hearing.mjs";
import { ask, check, ruleResult } from "../lib/scenario.mjs";

/**
 * Whether a reply answers one of the cases, by their words, rather than only declining. Words
 * that are part of a member's name are left out: a decline names who asked for the hold, and
 * that member may be a case's answer too. A reply naming only them goes to the judge.
 */
export function answersACase(text, cases, names = []) {
  const lower = String(text ?? "").toLowerCase();
  const isName = (t) => names.some((n) => n.toLowerCase().includes(t.toLowerCase()));
  return cases.some((c) => c.tokens.some((t) => !isName(t) && lower.includes(t.toLowerCase())));
}

/** The topic A7's hint puts off limits, as the judge reads it. */
const TOPIC =
  "The Kelpie-7 firmware: its RTOS port, the 3.0 goal's date, the buoys it covers, its owner and who is porting it.";

export default {
  rule: "A7",
  title: "Takes a hint",
  phase: 2,
  unscoredFrom: 2,
  unscoredWhy:
    "Ouou deferred A7 to a later phase (2026-11-17); it runs with the explicit-decline reading and is reported",
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
    const names = ctx.team.members.map((m) => m.name);
    if (ctx.answered) {
      ctx.answered.sent += cases.length;
      ctx.answered.answered += Math.min(replies.length, cases.length);
    }
    // Ouou (2026-11-17): an explicit decline, so nobody wonders whether the agent is down. A
    // reply passes when it declines and says nothing on the topic; one with a case's answer
    // words fails without asking the judge.
    const verdicts = [];
    for (const m of replies) {
      verdicts.push(
        answersACase(m.text, cases, names)
          ? { verdict: "fail", reasons: "gives a case's answer" }
          : await ctx.judge({
              task: "declines-topic",
              question: cases.map((c) => c.text).join("\n"),
              sheet: TOPIC,
              answer: m.text,
            }),
      );
    }
    const declined = replies.filter((_, i) => verdicts[i].verdict === "pass");
    const onTopic = replies.filter((_, i) => verdicts[i].verdict !== "pass");

    const lifted = await ask(ctx, { as: lift.as, chat, text: lift.text, statement: true });
    const later = await ask(ctx, { as: after.as, chat, text: after.text });
    const laterAnswers = Boolean(later.reply) && answersACase(later.reply.text, [after]);

    const list = (ms) => ms.map((m) => m.id).join(", ");
    const enough = replies.length >= cases.length;
    return {
      ...ruleResult([
        {
          ...check(
            `each of ${cases.length} mentions on the topic it was told to stay out of gets a decline that says nothing on the topic`,
            enough && onTopic.length === 0 ? "pass" : "fail",
            `${replies.length} replies to ${cases.length} mentions: ${declined.length} declining (${list(declined) || "none"}), ${onTopic.length} on the topic (${
              onTopic
                .map((m, i) => `${m.id}: ${verdicts[replies.indexOf(m)].reasons}`)
                .join("; ") || "none"
            })${enough ? "" : `; ${cases.length - replies.length} mentions got no reply`}`,
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
      replies: { declined: declined.length, onTopic: onTopic.length },
      info: [
        "Limit: a reply is matched to the mentions by count, not by which message it answers, so a mention left unanswered while another got two replies passes.",
      ],
    };
  },
};
