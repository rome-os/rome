// Rule 11: on a Rome signed in to Rome Cloud, voice input works with no provider credential in
// the instance's config, and Rome Cloud records the seconds each listening session used.
import {
  fieldText,
  isListening,
  openPage,
  pageNow,
  recordField,
  voiceForm,
  waitForSteadyField,
} from "../lib/product.mjs";
import { setMessages, useTranscriber } from "../lib/runs.mjs";
import { check, notChecked, required, ruleResult } from "../lib/scenario.mjs";
import { browserLanguage } from "../lib/script.mjs";

/** How far Rome Cloud's seconds may be from the recording's length, as a fraction of it. */
export const SECONDS_TOLERANCE = 0.1;
/** How long Rome Cloud has to show the usage event after listening stops. */
const USAGE_WAIT_MS = 60000;

export default {
  rule: "11",
  title: "Rome Cloud provides it",
  phase: 1,
  async run(ctx) {
    const { env } = ctx;
    let status;
    try {
      status = await env.cloudStatus();
    } catch (error) {
      return notChecked(`the environment cannot report Rome Cloud: ${error.message}`);
    }
    if (!status.signedIn) return notChecked("the instance is not signed in to Rome Cloud");
    if (status.ownCredential)
      return notChecked(
        "the instance has its own ROME_TRANSCRIPTION_API_KEY, so it cannot show that Rome Cloud provides the credential",
      );

    const message = setMessages(ctx.script, "B")[0];
    if (ctx.transcriber === "stand-in")
      await env.transcriber({ mode: "stand-in", text: message.text });
    else await useTranscriber(ctx);

    const usageBefore = (await env.cloudUsage()).events.length;
    const opened = await openPage(env, {
      mic: message.path,
      language: browserLanguage(message),
    });
    let listened;
    let heard;
    try {
      const { page } = opened;
      const form = await voiceForm(page).catch(() => null);
      if (!form)
        return ruleResult([
          required(
            check("voice control shown", "fail", "the message field shows no voice control"),
          ),
        ]);
      await recordField(form.field, form.control);
      const startedAt = await pageNow(page);
      await form.control.click();
      // Listen for the whole recording, so the seconds used match its length.
      await page.waitForTimeout(message.seconds * 1000);
      if (await isListening(form.control)) await form.control.click();
      listened = ((await pageNow(page)) - startedAt) / 1000;
      await waitForSteadyField(page, { quietMs: ctx.waits.steadyMs });
      heard = await fieldText(form.field);
      await form.field.fill("");
    } finally {
      await opened.close();
    }

    const checks = [
      required(
        check(
          "text appears with no credential in the instance",
          heard.trim() ? "pass" : "fail",
          heard.trim()
            ? `the field shows "${heard}" for ${message.key}`
            : `the field stayed empty for ${message.key}`,
          [message.key],
        ),
      ),
    ];

    const usage = await waitForUsage(env, usageBefore);
    const seconds = usage?.seconds;
    const off =
      seconds === undefined ? null : Math.abs(seconds - message.seconds) / message.seconds;
    checks.push(
      required(
        check(
          "Rome Cloud records the seconds",
          off !== null && off <= SECONDS_TOLERANCE ? "pass" : "fail",
          seconds === undefined
            ? `Rome Cloud shows no new usage within ${USAGE_WAIT_MS / 1000} s of listening stopping`
            : `Rome Cloud records ${seconds} s for a ${message.seconds} s recording (${Math.round(off * 100)}% off); listening lasted ${listened.toFixed(1)} s`,
          [message.key],
        ),
      ),
    );
    return ruleResult(checks);
  },
};

/** The first usage event after the `before` events already shown, or undefined after a wait. */
async function waitForUsage(env, before) {
  const start = Date.now();
  while (Date.now() - start < USAGE_WAIT_MS) {
    const { events } = await env.cloudUsage();
    if (events.length > before) return events[before];
    await new Promise((r) => setTimeout(r, 500));
  }
  return undefined;
}
