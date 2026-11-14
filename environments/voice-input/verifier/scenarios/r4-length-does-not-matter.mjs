// Rule 4: the 3-minute message comes out with its first and last sentences present and within
// the bar of rule 3. Set A's long message is real speech, set B's is synthesized; both count.
import {
  fieldText,
  isListening,
  openPage,
  recordField,
  voiceForm,
  waitForControlReturn,
  waitForSteadyField,
} from "../lib/product.mjs";
import { standInReason, useTranscriber } from "../lib/runs.mjs";
import { check, notChecked, required, ruleResult } from "../lib/scenario.mjs";
import { browserLanguage } from "../lib/script.mjs";
import { errors, errorsWithin, per100 } from "../lib/text.mjs";
import { BAR_PER_100 } from "./r3-what-you-said.mjs";

/** A sentence is present when at most this share of its words or characters is wrong. */
export const SENTENCE_WRONG_SHARE = 0.25;

export default {
  rule: "4",
  title: "Length does not matter",
  phase: 2,
  async run(ctx) {
    if (ctx.transcriber === "stand-in") return notChecked(standInReason(ctx));
    await useTranscriber(ctx);
    const standIn = standInReason(ctx);
    if (standIn) return notChecked(standIn);
    const longs = ctx.script.longs ?? [];
    if (longs.length === 0) return notChecked("the script has no long message");
    const checks = [];
    for (const message of longs) checks.push(...(await scoreLong(ctx, message)));
    for (const set of ["A", "B"])
      if (!longs.some((m) => m.set === set))
        checks.push(
          required(
            check(`set ${set}`, "not_checked", `the script has no long message in set ${set}`),
          ),
        );
    return ruleResult(checks);
  },
};

async function scoreLong(ctx, message) {
  const label = `set ${message.set}, ${message.key} (${Math.round(message.seconds)} s${message.synthesized ? ", synthesized" : ""})`;
  let heard;
  try {
    heard = await dictate(ctx, message);
  } catch (error) {
    return [required(check(label, "not_checked", `run broke: ${error.message}`, [message.key]))];
  }
  const whole = errors(message.text, heard, message.language);
  const rate = per100([whole]);
  const sentences = message.sentences ?? [];
  const checks = [
    required(
      check(
        `${label}: wrong in 100`,
        rate <= BAR_PER_100 ? "pass" : "fail",
        `${rate} (${whole.wrong} wrong of ${whole.of}); the bar is ${BAR_PER_100}`,
        [message.key],
      ),
    ),
  ];
  for (const [which, sentence] of [
    ["first", sentences[0]],
    ["last", sentences.at(-1)],
  ]) {
    if (!sentence) {
      checks.push(
        required(check(`${label}: ${which} sentence`, "not_checked", "no sentence list")),
      );
      continue;
    }
    const found = errorsWithin(sentence.text, heard, message.language);
    const present = found.wrong <= Math.floor(found.of * SENTENCE_WRONG_SHARE);
    checks.push(
      required(
        check(
          `${label}: ${which} sentence present`,
          present ? "pass" : "fail",
          `"${sentence.text}": ${found.wrong} of ${found.of} wrong at best in the field; present means at most ${SENTENCE_WRONG_SHARE * 100}% wrong`,
          [message.key],
        ),
      ),
    );
  }
  checks.push(check(`${label}: heard`, "info", `"${heard}"`, [message.key]));
  return checks;
}

/** Listens to the whole long recording in one session and resolves to the field's text. */
async function dictate(ctx, message) {
  const opened = await openPage(ctx.env, {
    mic: message.path,
    language: browserLanguage(message),
  });
  try {
    const { page } = opened;
    const { control, field } = await voiceForm(page);
    await recordField(field, control);
    await control.click();
    await page.waitForTimeout(message.lastWordAt * 1000 + ctx.waits.afterSpeechMs);
    if (await isListening(control)) await control.click();
    await waitForControlReturn(page, control);
    await waitForSteadyField(page, { quietMs: ctx.waits.steadyMs });
    return await fieldText(field);
  } finally {
    await opened.close();
  }
}
