import { presentedAsCurrent } from "../lib/checks.mjs";
import { ask, check, judged, ruleResult } from "../lib/scenario.mjs";
import { goalsSheet } from "../lib/seed.mjs";

export const K2_QUESTION = "What are the team's current goals? Give each goal's owner and date.";

export default {
  rule: "K2",
  title: "Goals",
  phase: 1,
  async run(ctx) {
    const { team } = ctx;
    const as = team.members[1].account;
    const { questionId, reply } = await ask(ctx, { as, text: K2_QUESTION });
    ctx.memo.K2 = { questionId, reply };
    if (!reply) {
      return ruleResult([
        check("answered", "fail", "no reply within the reply wait", [questionId]),
      ]);
    }
    const evidence = [questionId, reply.id];
    // R4: naming a dropped goal as dropped is right; presenting it as current fails.
    const stale = presentedAsCurrent(
      reply.text,
      team.droppedGoals.flatMap((g) => g.tokens),
    );
    const verdict = await ctx.judge({
      task: "matches-sheet",
      question: K2_QUESTION,
      sheet: goalsSheet(team),
      answer: reply.text,
    });
    return ruleResult([
      stale.length > 0
        ? check(
            "presents no dropped goal as current",
            "fail",
            `presented a dropped goal as current: ${stale.join(", ")}`,
            evidence,
          )
        : check(
            "presents no dropped goal as current",
            "pass",
            "no dropped goal presented as current",
            evidence,
          ),
      judged("every current goal with owner and date", verdict, evidence, reply.text),
    ]);
  },
};
