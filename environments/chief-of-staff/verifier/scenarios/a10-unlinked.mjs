import { factCheck, loadHearing, silentCheck } from "../lib/hearing.mjs";
import { ask, check, ruleResult } from "../lib/scenario.mjs";

/**
 * Proposed to Ouou (2026-11-18): once the chief of staff is unlinked from its connected
 * account, a mention gets no reply; linked again, a mention is answered. Whether a fact said
 * while it was unlinked stays unknown is a question for Ouou, so it is reported, not scored.
 */
export default {
  rule: "A10",
  title: "Unlinking turns it off",
  phase: 3,
  async run(ctx) {
    const { unlinkedPing, unlinkedFact, relinkPing } = loadHearing().a10;
    const checks = [];
    let factId;
    await ctx.env.unlink();
    try {
      const pingId = await ctx.env.post({ ...unlinkedPing, mentionAgent: true });
      factId = await ctx.env.post(unlinkedFact);
      checks.push(
        await silentCheck(ctx, {
          chats: [unlinkedPing.chat],
          since: pingId,
          ms: ctx.waits.a1Ms,
          name: "a mention while unlinked gets no reply",
        }),
      );
    } finally {
      await ctx.env.link();
    }
    const { questionId, reply } = await ask(ctx, {
      ...relinkPing,
      timeoutMs: ctx.waits.a1Ms,
    });
    checks.push(
      check(
        "a mention once linked again is answered",
        reply ? "pass" : "fail",
        reply ? `answered in ${reply.id}` : `no reply within ${ctx.waits.a1Ms / 1000} s`,
        [questionId, reply?.id],
      ),
    );
    const unheard = await factCheck(
      ctx,
      unlinkedFact,
      factId,
      "a fact said while unlinked stays unknown",
      { recall: false },
    );
    return {
      ...ruleResult(checks),
      info: [`Not scored, waiting on Ouou: ${unheard.name}: ${unheard.status}, ${unheard.detail}.`],
    };
  },
};
