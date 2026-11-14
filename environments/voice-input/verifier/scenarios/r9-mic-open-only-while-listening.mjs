// Rule 9: the microphone is open only while you can see it listening. It closes within 1 second
// of every stop, including each stop of rule 7, and listening stops by itself after 30 seconds
// without speech. The microphone's state is its capture tracks' state in the browser, never the
// control's label.
import {
  fieldText,
  isListening,
  openPage,
  recordField,
  voiceForm,
  waitForListening,
} from "../lib/product.mjs";
import { setMessages, useTranscriber } from "../lib/runs.mjs";
import { check, required, ruleResult } from "../lib/scenario.mjs";
import { browserLanguage } from "../lib/script.mjs";
import { runStops } from "../lib/stops.mjs";
import { micState, waitForMicClosed, waitForNotice, watchPage } from "../lib/watch.mjs";

/** How soon after a stop the microphone must be closed. */
export const CLOSE_MS = 1000;
/** Seconds without speech after which listening stops by itself; tests shorten it. */
export const silenceSeconds = () => Number(process.env.VERIFY_SILENCE_S ?? 30);
/** How far either side of that the stop may come, for the transcriber's lag in calling silence. */
const SILENCE_SLACK_S = 3;

export default {
  rule: "9",
  title: "The microphone is open only while you can see it listening",
  phase: 2,
  async run(ctx) {
    await useTranscriber(ctx);
    const message = setMessages(ctx.script, "B").find((m) => m.language === "en");
    const checks = [required(await guardianStop(ctx, message))];
    const { outcomes } = await runStops(ctx);
    for (const o of outcomes) checks.push(required(closedCheck(`closes after: ${o.kind}`, o)));
    checks.push(...(await silence(ctx, message)));
    return ruleResult(checks);
  },
};

function closedCheck(name, o) {
  if (o.error) return check(name, "not_checked", `could not run the stop: ${o.error}`);
  if (o.micClosedMs === null)
    return check(name, "fail", "an audio capture track was still live 3 s after the stop");
  return check(
    name,
    o.micClosedMs <= CLOSE_MS ? "pass" : "fail",
    `the microphone's capture tracks ended ${Math.round(o.micClosedMs)} ms after the stop; the bar is ${CLOSE_MS} ms`,
  );
}

/** The guardian's own stop action: the tracks are live while listening and end within 1 s. */
async function guardianStop(ctx, message) {
  const name = "closes after: the guardian's stop action";
  const opened = await openPage(ctx.env, { mic: message.path, language: browserLanguage(message) });
  try {
    const { page } = opened;
    await watchPage(page);
    const { control } = await voiceForm(page);
    await control.click();
    await page.waitForTimeout(((message.firstWordAt + message.lastWordAt) / 2) * 1000);
    const live = (await micState(page)).open;
    if (live === 0 || !(await isListening(control)))
      return check(
        name,
        "fail",
        `while the control showed listening ${live} capture tracks were live`,
      );
    const at = await page.evaluate(() => performance.now());
    await control.click();
    return closedCheck(name, { micClosedMs: await waitForMicClosed(page, at) });
  } finally {
    await opened.close();
  }
}

/**
 * After the last word the recording is silent. Listening must stop by itself about 30 s later,
 * say why, keep the words, and close the microphone.
 */
async function silence(ctx, message) {
  const limit = silenceSeconds();
  const opened = await openPage(ctx.env, { mic: message.path, language: browserLanguage(message) });
  try {
    const { page } = opened;
    await watchPage(page);
    const { control, form, field } = await voiceForm(page);
    await recordField(field, control);
    const startedAt = await page.evaluate(() => performance.now());
    await control.click();
    await waitForListening(page, control);
    const deadline = Date.now() + (message.lastWordAt + limit + SILENCE_SLACK_S + 5) * 1000;
    while ((await isListening(control)) && Date.now() < deadline) await page.waitForTimeout(100);
    const stoppedAt = await page.evaluate(() => performance.now());
    if (await isListening(control))
      return [
        required(
          check(
            "stops after 30 s without speech",
            "fail",
            `still listening ${Math.round((stoppedAt - startedAt) / 1000 - message.lastWordAt)} s after the last word`,
            [message.key],
          ),
        ),
      ];
    const quiet = (stoppedAt - startedAt) / 1000 - message.lastWordAt;
    const inTime = quiet >= limit - SILENCE_SLACK_S && quiet <= limit + SILENCE_SLACK_S;
    const notice = await waitForNotice(page, form, stoppedAt);
    const heard = await fieldText(field);
    return [
      required(
        check(
          "stops after 30 s without speech",
          inTime ? "pass" : "fail",
          `listening stopped ${quiet.toFixed(1)} s after the last word; the bar is ${limit} s ± ${SILENCE_SLACK_S} s; notice "${notice?.text ?? "none"}"; the field kept "${heard.trim()}"`,
          [message.key],
        ),
      ),
      required(
        closedCheck("closes after: 30 s without speech", {
          micClosedMs: await waitForMicClosed(page, stoppedAt),
        }),
      ),
    ];
  } finally {
    await opened.close();
  }
}
