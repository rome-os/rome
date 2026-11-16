import { aDayLater, loadHearing } from "../lib/hearing.mjs";
import { ask, check, judged, ruleResult } from "../lib/scenario.mjs";
import { K2_QUESTION } from "./k2-goals.mjs";

/** The goals answer sheet after K4's changes. */
export function changedGoalsSheet(team, changes) {
  return team.goals
    .map((g) => ({ ...g, ...(changes.find((c) => c.goal === g.id) ?? {}) }))
    .map((g) => `- "${g.title}", owner ${g.owner}, date ${g.date}`)
    .join("\n");
}

export default {
  rule: "K4",
  title: "Stays current",
  phase: 2,
  async run(ctx) {
    const { changeIds, hours } = await aDayLater(ctx);
    const changes = loadHearing().k4Changes.map(({ goal, title, owner, date }) =>
      Object.fromEntries(
        Object.entries({ goal, title, owner, date }).filter(([, v]) => v !== undefined),
      ),
    );
    const { questionId, reply } = await ask(ctx, {
      as: ctx.team.members[0].account,
      text: K2_QUESTION,
    });
    const evidence = [...changeIds, questionId, reply?.id];
    if (!reply)
      return ruleResult([check("answered", "fail", "no reply within the reply wait", evidence)]);
    const verdict = await ctx.judge({
      task: "matches-sheet",
      question: K2_QUESTION,
      sheet: changedGoalsSheet(ctx.team, changes),
      answer: reply.text,
    });
    return ruleResult([
      judged(
        `goals with one goal and one owner changed in the chat, asked ${hours} h later`,
        verdict,
        evidence,
        reply.text,
      ),
    ]);
  },
};
