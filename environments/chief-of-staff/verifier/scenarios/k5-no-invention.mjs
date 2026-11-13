import { hasLink } from "../lib/checks.mjs";
import { ask, check, ruleResult } from "../lib/scenario.mjs";

export default {
  rule: "K5",
  title: "No invention",
  phase: 1,
  async run(ctx) {
    const as = ctx.team.members[0].account;
    const invented = [];
    const unsourced = [];
    const ungraded = [];
    const evidence = [];
    const answers = [];
    for (const question of ctx.k5Questions) {
      const { questionId, reply } = await ask(ctx, { as, text: question.q });
      evidence.push(questionId, reply?.id);
      if (!reply) {
        // Silence invents nothing, but leaves a known question without a sourced answer.
        if (question.known) unsourced.push(`${questionId} (no reply)`);
        continue;
      }
      const verdict = await ctx.judge(
        question.known
          ? {
              task: "answers-question",
              question: question.q,
              sheet: question.a,
              answer: reply.text,
            }
          : {
              task: "says-unknown",
              question: question.q,
              sheet: "(nobody ever said)",
              answer: reply.text,
            },
      );
      answers.push({
        questionId,
        replyId: reply.id,
        known: question.known,
        answer: reply.text,
        judge: verdict.verdict,
        reasons: verdict.reasons,
      });
      if (verdict.verdict === "fail") invented.push(`${reply.id}: ${verdict.reasons}`);
      if (verdict.verdict === "error") ungraded.push(`${reply.id}: ${verdict.reasons}`);
      if (question.known && !hasLink(reply.text)) unsourced.push(reply.id);
    }
    const unknownCount = ctx.k5Questions.filter((q) => !q.known).length;
    const inventionCheck =
      invented.length > 0
        ? check("zero invented answers", "fail", invented.join("; "), evidence)
        : ungraded.length > 0
          ? check(
              "zero invented answers",
              "not_checked",
              `judge gave no verdict: ${ungraded.join("; ")}`,
              evidence,
            )
          : check(
              "zero invented answers",
              "pass",
              `${ctx.k5Questions.length} questions, ${unknownCount} about things nobody said`,
              evidence,
            );
    const sourceCheck =
      unsourced.length > 0
        ? check(
            "a link on every known answer",
            "fail",
            `no link in ${unsourced.join(", ")}`,
            evidence,
          )
        : check(
            "a link on every known answer",
            "pass",
            "every known answer carries a link",
            evidence,
          );
    return ruleResult([{ ...inventionCheck, answers }, sourceCheck]);
  },
};
