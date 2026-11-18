import { linkedIds, namesSource } from "../lib/checks.mjs";
import { ask, check, ruleResult, waitsOnDecision } from "../lib/scenario.mjs";
import { goalsSheet, rosterSheet } from "../lib/seed.mjs";

export default {
  rule: "K5",
  title: "No invention",
  phase: 1,
  async run(ctx) {
    // An answer may add true facts from the team's documents; only facts found nowhere invent.
    const documents = `${rosterSheet(ctx.team)}\n\n${goalsSheet(ctx.team)}`;
    const invented = [];
    const unsourced = [];
    const ungraded = [];
    const evidence = [];
    const answers = [];
    // One chat, one question at a time: asking in three chats at once queued behind the agent's
    // one session and took longer (run 2026-11-18T11-24-37).
    const as = ctx.team.members[0].account;
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
              documents,
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
      if (question.known && !namesSource(reply.text, ctx.team)) unsourced.push(reply.id);
    }
    const unknownCount = ctx.k5Questions.filter((q) => !q.known).length;
    const inventionCheck =
      invented.length > 0
        ? check("zero invented answers", "fail", invented.join("; "), evidence)
        : answers.length === 0
          ? check(
              "zero invented answers",
              "not_checked",
              "no answer to judge, so silence alone invented nothing",
              evidence,
            )
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
    // R3: a message source is a link to it; a document source names the document and the entry.
    const sourceCheck =
      unsourced.length > 0
        ? check(
            "a source on every known answer",
            "fail",
            `no link and no named document entry in ${unsourced.join(", ")}`,
            evidence,
          )
        : check(
            "a source on every known answer",
            "pass",
            "every known answer links its source or names the document and entry",
            evidence,
          );
    const linkCheck = messageLinkCheck(ctx);
    // Ouou (2026-11-17) deferred K5's sources to a later phase: from phase 2 K5 scores only
    // invention, and both source checks are reported with their counts.
    if ((ctx.phase ?? 1) >= 2) {
      const known = answers.filter((a) => a.known).length;
      return {
        ...ruleResult([{ ...inventionCheck, answers }]),
        info: [
          `Not scored in phase 2: ${known - unsourced.length} of ${known} known answers name a source${unsourced.length ? ` (none in ${unsourced.join(", ")})` : ""}.`,
          `Not scored in phase 2: a message source is linked: ${linkCheck.status}, ${linkCheck.detail}.`,
        ],
      };
    }
    return ruleResult([{ ...inventionCheck, answers }, sourceCheck, linkCheck]);
  },
};

const MESSAGE_LINKS = "whether the agent is given links to the messages it cites (a core change)";

/**
 * K5's message leg, on the K3 answers, which cite messages: each answer links at least one of
 * the commitments it reports, by that message's id. Phase 1 waits on the decision to give the
 * agent message links; from phase 2 it is scored.
 */
function messageLinkCheck(ctx) {
  const name = "a message source is linked";
  const replies = (ctx.memo.K3?.answers ?? []).filter((a) => a.reply);
  if (replies.length === 0)
    return check(name, "not_checked", "no K3 answer citing a message to check");
  const said = new Set(ctx.memo.K3.said ?? []);
  const evidence = replies.flatMap((a) => [a.questionId, a.reply.id]);
  const unlinked = replies
    .filter((a) => !linkedIds(a.reply.text).some((id) => said.has(id)))
    .map((a) => a.reply.id);
  const result =
    unlinked.length > 0
      ? check(name, "fail", `no link to a cited message in ${unlinked.join(", ")}`, evidence)
      : check(name, "pass", "every K3 answer links a message it cites", evidence);
  return (ctx.phase ?? 1) >= 2 ? result : waitsOnDecision(result, MESSAGE_LINKS);
}
