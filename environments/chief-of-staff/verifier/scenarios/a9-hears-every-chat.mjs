import { factCheck, loadHearing } from "../lib/hearing.mjs";
import { check, ruleResult } from "../lib/scenario.mjs";

/** The chat A9 changes, set back to Rome's defaults when A9 ends. */
const CHAT = "standup";

/**
 * Proposed to Ouou (2026-11-18): the chief of staff's connected account records every
 * message, whatever the chat's settings. A fact said without a mention in a chat set to
 * "mentions only", one said mentioning someone else in a chat set to ignore such messages,
 * and one said in a chat switched off are each recalled when a member asks in `general`.
 */
export default {
  rule: "A9",
  title: "Hears every chat, whatever its settings",
  phase: 3,
  async run(ctx) {
    const checks = [];
    try {
      for (const fact of loadHearing().a9Facts) {
        const name = `recalls a fact said in a chat set to ${fact.setting}`;
        await ctx.env.chatSetting(CHAT, fact.setting);
        let saidId;
        try {
          saidId = await ctx.env.post({
            as: fact.as,
            chat: CHAT,
            mentionSecond: Boolean(fact.mentionSecond),
            text: fact.text,
          });
        } catch (error) {
          // Mentioning someone else needs the environment's second bot.
          checks.push(check(name, "not_checked", error.message));
          continue;
        }
        checks.push(await factCheck(ctx, fact, saidId, name));
      }
    } finally {
      await ctx.env.chatSetting(CHAT, "default");
    }
    return ruleResult(checks);
  },
};
