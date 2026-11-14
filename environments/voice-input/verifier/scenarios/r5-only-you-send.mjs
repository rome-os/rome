// Rule 5: in all 20 script runs, the chat has no new message 60 s after listening stops, and
// the message appears only after the usual send action.
import { scriptRuns } from "../lib/runs.mjs";
import { check, required, ruleResult } from "../lib/scenario.mjs";

const normalise = (s) => s.replace(/\s+/g, " ").trim();

export default {
  rule: "5",
  title: "Only you send",
  phase: 1,
  async run(ctx) {
    const { runs } = await scriptRuns(ctx);
    const wait = `${ctx.waits.sendCheckMs / 1000} s`;
    const checks = runs.map((run) => {
      if (run.error) return required(check(run.key, "not_checked", `run broke: ${run.error}`));
      if (run.newAfterWait.length > 0) {
        return check(
          run.key,
          "fail",
          `${run.newAfterWait.length} message(s) appeared without the send action within ${wait}`,
          run.newAfterWait.map((m) => m.id),
        );
      }
      const [sent] = run.sent;
      if (!sent) return check(run.key, "fail", "no message appeared after the send action");
      if (normalise(sent.text) !== normalise(run.heard)) {
        return check(
          run.key,
          "fail",
          `the sent message "${sent.text}" differs from the field "${run.heard}"`,
          [sent.id],
        );
      }
      return check(run.key, "pass", `nothing sent within ${wait}; the send action sent the field`, [
        sent.id,
      ]);
    });
    return ruleResult(checks);
  },
};
