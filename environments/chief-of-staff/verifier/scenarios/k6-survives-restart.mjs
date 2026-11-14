import { ask, check, judged, required, ruleResult } from "../lib/scenario.mjs";
import { goalsSheet, rosterSheet } from "../lib/seed.mjs";
import { K1_QUESTION } from "./k1-team.mjs";
import { K2_QUESTION } from "./k2-goals.mjs";

const QUESTIONS = [
  { rule: "K1", text: K1_QUESTION, member: 2, sheet: rosterSheet },
  { rule: "K2", text: K2_QUESTION, member: 1, sheet: goalsSheet },
];

/** Asks the K1 and K2 questions again and compares each answer with the one in `before`. */
async function sameFactsAfter(ctx, before, label) {
  const checks = [];
  for (const q of QUESTIONS) {
    const earlier = before[q.rule];
    const later = await ask(ctx, { as: ctx.team.members[q.member].account, text: q.text });
    const evidence = [earlier.questionId, earlier.reply?.id, later.questionId, later.reply?.id];
    const name = `${q.rule} answer ${label}`;
    if (!earlier.reply) {
      checks.push(check(name, "not_checked", "no answer before to compare with", evidence));
    } else if (!later.reply) {
      checks.push(check(name, "fail", "no reply after", evidence));
    } else {
      const verdict = await ctx.judge({
        task: "same-facts",
        question: q.text,
        // R4: only the answer sheet's facts must survive; other facts may come and go.
        sheet: q.sheet(ctx.team),
        before: earlier.reply.text,
        answer: later.reply.text,
      });
      checks.push(judged(name, verdict, evidence, later.reply.text));
    }
  }
  return checks;
}

export default {
  rule: "K6",
  title: "Survives a restart",
  phase: 1,
  async run(ctx) {
    const before = {};
    for (const q of QUESTIONS) {
      // Reuse the K1 and K2 answers when those rules ran in this run.
      before[q.rule] =
        ctx.memo[q.rule] ??
        (await ask(ctx, { as: ctx.team.members[q.member].account, text: q.text }));
    }

    const checks = [];
    // A renewed session and a Rome restart are both part of the rule. When cos-env cannot
    // renew the session, that half stays unchecked and K6 cannot pass.
    try {
      // Renewal is armed per chat, so renew the private chats the K1 and K2 questions use.
      for (const q of QUESTIONS)
        await ctx.env.renewSession(`dm-${ctx.team.members[q.member].account}`);
      ctx.log("agent session renewed");
      checks.push(...(await sameFactsAfter(ctx, before, "after the session is renewed")));
    } catch (error) {
      checks.push(
        required(
          check(
            "answers after the session is renewed",
            "not_checked",
            `cos-env could not renew the session: ${error.message}`,
          ),
        ),
      );
    }

    await ctx.env.rome("restart");
    ctx.log("Rome restarted");
    checks.push(...(await sameFactsAfter(ctx, before, "after Rome restarts")));
    return ruleResult(checks);
  },
};
