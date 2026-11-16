import { linkedIds } from "../lib/checks.mjs";
import { aDayLater, holdsAll, loadHearing } from "../lib/hearing.mjs";
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
    const said = loadHearing().k4Changes;
    const changes = said.map(({ goal, title, owner, date }) =>
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
    // Unscored, for Ouou's reading of the rule: whether the answer shows each change at all,
    // anywhere in it, and whether it links the message the change was said in.
    const links = linkedIds(reply.text);
    const shown = said.map((c, i) => {
      const linked = links.includes(changeIds[i]);
      return {
        change: changeIds[i],
        shown: linked || (c.tokens.length > 0 && holdsAll(reply.text, c.tokens)),
        linked,
      };
    });
    const info = [
      `Not scored: the answer shows ${shown.filter((c) => c.shown).length} of ${shown.length} changes anywhere in it, ${shown.filter((c) => c.linked).length} with a link to the message that said it (${shown.map((c) => `${c.change}: ${c.shown ? "shown" : "not shown"}${c.linked ? ", linked" : ""}`).join("; ")})`,
    ];
    return {
      ...ruleResult([
        judged(
          `goals with one goal and one owner changed in the chat, asked ${hours} h later`,
          verdict,
          evidence,
          reply.text,
        ),
      ]),
      changesShown: shown,
      info,
    };
  },
};
