// Rule 3: over the script, English has at most 8 wrong words in 100, and Mandarin and mixed
// messages at most 8 wrong characters in 100. Normalisation: lib/text.mjs.
import { scriptRuns } from "../lib/runs.mjs";
import { check, notChecked, required, ruleResult } from "../lib/scenario.mjs";
import { errors, per100 } from "../lib/text.mjs";

export const BAR_PER_100 = 8;

export default {
  rule: "3",
  title: "The text is what you said",
  phase: 1,
  async run(ctx) {
    if (ctx.transcriber === "stand-in")
      return notChecked(
        "the stand-in transcriber returns the written text, so accuracy is not measured; needs a provider credential",
      );
    const { runs } = await scriptRuns(ctx);
    const broken = runs.filter((r) => r.error);
    const scored = runs
      .filter((r) => !r.error)
      .map((r) => ({ ...r, ...errors(r.written, r.heard, r.language) }));
    const pool = (langs) => scored.filter((r) => langs.includes(r.language));
    const checks = [
      poolCheck("English, wrong words in 100", pool(["en"])),
      poolCheck("Mandarin and mixed, wrong characters in 100", pool(["zh", "mixed"])),
    ];
    if (broken.length > 0) {
      checks.push(
        required(
          check(
            "every message scored",
            "not_checked",
            `${broken.length} runs broke: ${broken.map((r) => `${r.key} (${r.error})`).join("; ")}`,
            broken.map((r) => r.key),
          ),
        ),
      );
    }
    const detail = scored.map((r) =>
      check(r.key, "info", `${r.wrong} wrong of ${r.of}; heard "${r.heard}"`, [r.key]),
    );
    const info = [
      check("Mandarin alone", "info", `${per100(pool(["zh"]))} wrong characters in 100`),
      check("mixed alone", "info", `${per100(pool(["mixed"]))} wrong characters in 100`),
    ];
    return { ...ruleResult(checks), checks: [...checks, ...info, ...detail] };
  },
};

function poolCheck(name, pool) {
  const rate = per100(pool);
  if (rate === null)
    return required(check(name, "not_checked", "no message of this language scored"));
  return required(
    check(
      name,
      rate <= BAR_PER_100 ? "pass" : "fail",
      `${rate} over ${pool.length} messages; the bar is ${BAR_PER_100}`,
      pool.map((r) => r.key),
    ),
  );
}
