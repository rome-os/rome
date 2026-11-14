// Rule 2: in at least 18 of the 20 script messages, text first appears within 2 s of the first
// word and is complete within 2 s of the last word.
import { scriptRuns, standInReason, textTimes, useTranscriber } from "../lib/runs.mjs";
import { check, notChecked, required, ruleResult } from "../lib/scenario.mjs";

export const BAR_SECONDS = 2;
/** 18 of the script's 20 messages; a shorter script, as in the tests, keeps the same share. */
export const SHARE_NEEDED = 18 / 20;

export default {
  rule: "2",
  title: "Text appears as you speak",
  phase: 1,
  async run(ctx) {
    // The stand-in answers with the written text on fixed times, so streaming is not measured.
    if (ctx.transcriber === "stand-in") return notChecked(standInReason(ctx));
    await useTranscriber(ctx);
    const standIn = standInReason(ctx);
    if (standIn) return notChecked(standIn);
    const { runs } = await scriptRuns(ctx);
    const scored = runs.map((run) => {
      if (run.error) return { key: run.key, ok: false, detail: `run broke: ${run.error}` };
      const times = textTimes(run);
      if (!times) return { key: run.key, ok: false, detail: "no text appeared" };
      const firstDelay = times.firstTextAt - run.firstWordAt;
      const completeDelay = times.completeAt - run.lastWordAt;
      return {
        key: run.key,
        ok: firstDelay <= BAR_SECONDS && completeDelay <= BAR_SECONDS,
        detail: `first text ${firstDelay.toFixed(2)} s after the first word, complete ${completeDelay.toFixed(2)} s after the last word`,
      };
    });
    const passing = scored.filter((s) => s.ok).length;
    const needed = Math.ceil(runs.length * SHARE_NEEDED - 1e-9);
    const perMessage = scored.map((s) =>
      check(s.key, "info", `${s.ok ? "within" : "outside"} the bar: ${s.detail}`, [s.key]),
    );
    const tally = required(
      check(
        "messages within the bar",
        passing >= needed ? "pass" : "fail",
        `${passing} of ${runs.length} messages within ${BAR_SECONDS} s; the bar is ${needed} of ${runs.length}`,
        scored.filter((s) => !s.ok).map((s) => s.key),
      ),
    );
    return { ...ruleResult([tally]), checks: [tally, ...perMessage] };
  },
};
