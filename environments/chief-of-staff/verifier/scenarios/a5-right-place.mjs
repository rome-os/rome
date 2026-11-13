import { check, ruleResult } from "../lib/scenario.mjs";
import { collectMentions } from "./a1-present.mjs";

/**
 * In phase 1, A5 reads where A1's replies landed. A reply to a mention at the top of a chat
 * belongs in that chat, at the top or in a thread started from the mention. A reply to a
 * mention in a thread belongs in that thread.
 */
export default {
  rule: "A5",
  title: "Right place",
  phase: 1,
  async run(ctx) {
    const mentions = await collectMentions(ctx);
    return ruleResult(
      mentions.map((m) => {
        const name = m.thread ? `${m.chat} thread ${m.thread}` : m.chat;
        const evidence = [m.questionId, m.reply?.id];
        if (!m.reply) return check(name, "not_checked", "no reply to place", evidence);
        const landed = m.reply.thread ? `${m.reply.chat} thread ${m.reply.thread}` : m.reply.chat;
        const right = m.thread
          ? m.reply.chat === m.chat && m.reply.thread === m.thread
          : m.reply.chat === m.chat && (!m.reply.thread || m.reply.thread === m.questionId);
        return right
          ? check(name, "pass", `reply in ${landed}`, evidence)
          : check(name, "fail", `reply landed in ${landed}`, evidence);
      }),
    );
  },
};
