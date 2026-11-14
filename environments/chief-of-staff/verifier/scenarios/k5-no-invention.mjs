import { hasLink, namesSource } from "../lib/checks.mjs";
import { ask, check, ruleResult, waitsOnDecision } from "../lib/scenario.mjs";
import { goalsSheet, rosterSheet } from "../lib/seed.mjs";

export default {
  rule: "K5",
  title: "No invention",
  phase: 1,
  async run(ctx) {
    const as = ctx.team.members[0].account;
    // An answer may add true facts from the team's documents; only facts found nowhere invent.
    const documents = `${rosterSheet(ctx.team)}\n\n${goalsSheet(ctx.team)}`;
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
    return ruleResult([{ ...inventionCheck, answers }, sourceCheck, messageLinkCheck(ctx)]);
  },
};

const MESSAGE_LINKS = "whether the agent is given links to the messages it cites (a core change)";

/**
 * R4's K5 asks that a source that is a message be a link to it. The K3 answers each cite
 * the messages a commitment was said in, so they carry this check. Until the agent can be
 * given message links, a missing link waits on that decision rather than failing.
 */
function messageLinkCheck(ctx) {
  const name = "a message source is linked";
  const replies = (ctx.memo.K3?.answers ?? []).filter((a) => a.reply);
  if (replies.length === 0)
    return check(name, "not_checked", "no K3 answer citing a message to check");
  const evidence = replies.flatMap((a) => [a.questionId, a.reply.id]);
  const unlinked = replies.filter((a) => !hasLink(a.reply.text)).map((a) => a.reply.id);
  return unlinked.length > 0
    ? waitsOnDecision(
        check(name, "fail", `no message link in ${unlinked.join(", ")}`, evidence),
        MESSAGE_LINKS,
      )
    : check(name, "pass", "every K3 answer links the messages it cites", evidence);
}
