import { holdsAll, loadHearing } from "../lib/hearing.mjs";
import { ask, check, ruleResult } from "../lib/scenario.mjs";

/** Turns between telling the agent the facts and asking for them back. */
const TURNS_BETWEEN = 30;

/** Facts recalled of 5 for a pass. */
const BAR = 4;

/**
 * For the fresh-context prototype (design thread, 2026-11-18): 5 facts told to the agent with
 * a mention, found in no document, are still in its answers 30 turns later. The turns between
 * are the K5 questions with answers, asked in `general` by each member in turn.
 */
export default {
  rule: "K8",
  title: "Keeps what it was told",
  phase: 3,
  async run(ctx) {
    const facts = loadHearing().k8Facts;
    const told = [];
    for (const fact of facts) {
      const { questionId } = await ask(ctx, {
        as: fact.as,
        chat: fact.chat,
        text: fact.text,
        statement: true,
      });
      told.push(questionId);
    }
    const members = ctx.team.members.map((m) => m.account);
    const known = ctx.k5Questions.filter((q) => q.known);
    const between = [];
    for (let i = 0; i < TURNS_BETWEEN; i++) {
      const { questionId, reply } = await ask(ctx, {
        as: members[i % members.length],
        chat: "general",
        text: known[i % known.length].q,
      });
      between.push({ questionId, replyId: reply?.id ?? null });
    }
    const answered = between.filter((b) => b.replyId).length;
    const answers = [];
    for (const [i, fact] of facts.entries()) {
      const as = members.find((m) => m !== fact.as);
      const { questionId, reply } = await ask(ctx, { as, chat: "general", text: fact.question });
      answers.push({
        told: told[i],
        questionId,
        replyId: reply?.id ?? null,
        recalled: Boolean(reply) && holdsAll(reply.text, fact.tokens),
      });
    }
    const recalled = answers.filter((a) => a.recalled).length;
    const missed = answers.filter((a) => !a.recalled);
    return {
      ...ruleResult([
        {
          ...check(
            `recalls facts told to it ${TURNS_BETWEEN} turns earlier`,
            recalled >= BAR ? "pass" : "fail",
            `recalled ${recalled} of ${facts.length}, needs ${BAR}${missed.length ? `; missed ${missed.map((a) => `${a.told} (${a.replyId ? `answer ${a.replyId}` : "no reply"})`).join(", ")}` : ""}`,
            answers.flatMap((a) => [a.told, a.questionId, a.replyId]),
          ),
          answers,
        },
      ]),
      info: [
        `${TURNS_BETWEEN} questions asked between the facts and the recall, ${answered} answered; a question left unanswered is a turn the agent may not have taken.`,
      ],
    };
  },
};
