import { linkedIds } from "../lib/checks.mjs";
import { aDayLater, entryProblems, holdsAll, loadHearing } from "../lib/hearing.mjs";
import { ask, check, judged, required, ruleResult } from "../lib/scenario.mjs";
import { K2_QUESTION } from "./k2-goals.mjs";

/** The goals answer sheet after K4's changes. */
export function changedGoalsSheet(team, changes) {
  return team.goals
    .map((g) => ({ ...g, ...(changes.find((c) => c.goal === g.id) ?? {}) }))
    .map((g) => `- "${g.title}", owner ${g.owner}, date ${g.date}`)
    .join("\n");
}

/**
 * The goals document, read through the app: each change shows in its goal's entry with a link
 * to the message that said it, and the proposal that was not a decision leaves its goal as it
 * was. Ouou (2026-11-16): a goal changed in the chat is updated in the document.
 */
async function documentChecks(ctx, said, changeIds, proposal, proposalId, hours) {
  let doc;
  try {
    doc = await ctx.env.doc("goals");
  } catch (error) {
    const why = `could not read the goals document: ${error.message}`;
    // The rule now asks for the document, so K4 does not pass without reading it.
    return [
      required(check("the goals document shows each change, with its source", "not_checked", why)),
      required(
        check(
          "a proposal that is not a decision leaves the document as it was",
          "not_checked",
          why,
        ),
      ),
    ];
  }
  const links = linkedIds(doc);
  const problems = said.flatMap((c, i) => [
    ...entryProblems(doc, c.doc).map((p) => `${c.goal}: ${p}`),
    ...(links.includes(changeIds[i]) ? [] : [`${c.goal}: no link to ${changeIds[i]}`]),
  ]);
  const unchanged = entryProblems(doc, proposal.doc);
  return [
    {
      ...check(
        `the goals document shows each change, with its source, ${hours} h later`,
        problems.length === 0 ? "pass" : "fail",
        problems.length === 0
          ? "each changed goal's entry holds the new value and links the message"
          : problems.join("; "),
        changeIds,
      ),
      quote: doc,
    },
    check(
      "a proposal that is not a decision leaves the document as it was",
      unchanged.length === 0 ? "pass" : "fail",
      unchanged.length === 0 ? "the proposed goal's entry is unchanged" : unchanged.join("; "),
      [proposalId],
    ),
  ];
}

export default {
  rule: "K4",
  title: "Stays current",
  phase: 2,
  async run(ctx) {
    const { changeIds, proposalId, hours } = await aDayLater(ctx);
    const { k4Changes: said, k4Proposal: proposal } = loadHearing();
    const changes = said.map(({ goal, title, owner, date }) =>
      Object.fromEntries(
        Object.entries({ goal, title, owner, date }).filter(([, v]) => v !== undefined),
      ),
    );
    const docChecks = await documentChecks(ctx, said, changeIds, proposal, proposalId, hours);
    const { questionId, reply } = await ask(ctx, {
      as: ctx.team.members[0].account,
      text: K2_QUESTION,
    });
    const evidence = [...changeIds, proposalId, questionId, reply?.id];
    if (!reply)
      return ruleResult([
        check("answered", "fail", "no reply within the reply wait", evidence),
        ...docChecks,
      ]);
    // The sheet keeps the proposed goal's date, so an answer giving the proposed date fails.
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
          `the answer gives the changed goals as current, asked ${hours} h later`,
          verdict,
          evidence,
          reply.text,
        ),
        ...docChecks,
      ]),
      changesShown: shown,
      info,
    };
  },
};
