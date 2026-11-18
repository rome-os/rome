import { factCheck, loadHearing, silentCheck } from "../lib/hearing.mjs";
import { ruleResult } from "../lib/scenario.mjs";

/**
 * Proposed to Ouou (2026-11-18): another bot's message never pings the chief of staff, so two
 * bots cannot answer each other forever, yet it is heard. The driver bot, posting as itself,
 * mentions the agent: no reply, and a member asking later gets the fact.
 */
export default {
  rule: "A12",
  title: "Another bot never pings it",
  phase: 3,
  async run(ctx) {
    const said = loadHearing().a12;
    const saidId = await ctx.env.post({ ...said, mentionAgent: true });
    return ruleResult([
      await silentCheck(ctx, {
        chats: [said.chat],
        since: saidId,
        ms: ctx.waits.a1Ms,
        name: "another bot's mention gets no reply",
      }),
      await factCheck(ctx, said, saidId, "another bot's message is heard"),
    ]);
  },
};
