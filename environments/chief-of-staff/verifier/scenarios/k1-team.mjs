import { tokensIn } from "../lib/checks.mjs";
import { ask, check, judged, ruleResult } from "../lib/scenario.mjs";
import { rosterSheet } from "../lib/seed.mjs";

export const K1_QUESTION =
  "Who is on the team? For each person, give their role and what they are working on now.";

export default {
  rule: "K1",
  title: "Team",
  phase: 1,
  async run(ctx) {
    const { team } = ctx;
    const as = team.members[2].account;
    const { questionId, reply } = await ask(ctx, { as, text: K1_QUESTION });
    ctx.memo.K1 = { questionId, reply };
    if (!reply) {
      return ruleResult([
        check("answered", "fail", "no reply within the reply wait", [questionId]),
      ]);
    }
    const evidence = [questionId, reply.id];
    const named = tokensIn(
      reply.text,
      team.formerMembers.flatMap((m) => m.tokens),
    );
    const verdict = await ctx.judge({
      task: "matches-sheet",
      question: K1_QUESTION,
      sheet: rosterSheet(team),
      answer: reply.text,
    });
    return ruleResult([
      named.length > 0
        ? check(
            "names nobody off the team",
            "fail",
            `named a former member: ${named.join(", ")}`,
            evidence,
          )
        : check("names nobody off the team", "pass", "no former member named", evidence),
      judged("every member with role and current work", verdict, evidence, reply.text),
    ]);
  },
};
