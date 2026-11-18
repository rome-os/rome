import { factCheck, loadHearing, silentCheck } from "../lib/hearing.mjs";
import { check, ruleResult } from "../lib/scenario.mjs";

/**
 * Proposed to Ouou (2026-11-18): the chief of staff hears only the connected account linked
 * to it. A fact said where only the environment's second Rome bot reads is never recalled,
 * and a mention of the second bot gets no reply from the chief of staff. Without a second
 * bot, A11 is not checked.
 */
export default {
  rule: "A11",
  title: "Hears only its own connected account",
  phase: 3,
  async run(ctx) {
    const { fact, secondPing } = loadHearing().a11;
    let factId;
    let pingId;
    try {
      factId = await ctx.env.post(fact);
      pingId = await ctx.env.post({ ...secondPing, mentionSecond: true });
    } catch (error) {
      return ruleResult([
        check(
          "the environment has a second connected account",
          "not_checked",
          `the second bot is not available: ${error.message}`,
        ),
      ]);
    }
    return ruleResult([
      await silentCheck(ctx, {
        chats: [secondPing.chat],
        since: pingId,
        ms: ctx.waits.a1Ms,
        name: "a mention of the second bot gets no reply from the chief of staff",
      }),
      {
        ...(await factCheck(
          ctx,
          fact,
          factId,
          "a fact said only to the second bot is not recalled",
          { recall: false },
        )),
        required: true,
      },
    ]);
  },
};
