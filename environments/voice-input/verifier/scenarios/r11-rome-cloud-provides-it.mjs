// Rule 11: Rome Cloud provides voice input to the accounts Ouou allows. With the gate off the
// dashboard has no voice control and Rome Cloud refuses a session; with it on, voice input works
// with no provider credential in the instance's config, and Rome Cloud records the seconds.
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
/** Rome caches what Rome Cloud says about voice input for 60 s, so a gate change shows within this. */
const GATE_WAIT_MS = 75000;
const PLACE_API = "/api/voice-input";

export default {
  rule: "11",
  title: "Rome Cloud provides it, to the accounts Ouou allows",
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
    const checks = await gateOff(env, message);
    await env.gate("on");
    await waitForAvailable(env, message, true);
    checks.push(...(await gateOn(ctx, message)));
    return ruleResult(checks);
  },
};

/** The gate-off half: no voice control, and Rome Cloud refuses a session and mints nothing. */
async function gateOff(env, message) {
  try {
    await env.gate("off");
  } catch (error) {
    return [
      required(
        check("gate off", "not_checked", `the environment cannot set the gate: ${error.message}`),
      ),
    ];
  }
  const checks = [];
  const available = await waitForAvailable(env, message, false);
  const opened = await openPage(env, { mic: message.path, language: browserLanguage(message) });
  let shown;
  try {
    shown = await voiceForm(opened.page, { timeoutMs: 5000 })
      .then(() => true)
      .catch(() => false);
  } finally {
    await opened.close();
  }
  checks.push(
    required(
      check(
        "gate off: no voice control",
        shown ? "fail" : "pass",
        shown
          ? `the dashboard shows a voice control; ${PLACE_API} says available ${available}`
          : `the dashboard shows no voice control; ${PLACE_API} says available ${available}`,
      ),
    ),
  );
  let refusal;
  try {
    const before = (await env.cloudMinted()).count;
    const session = await env.cloudSession();
    const after = (await env.cloudMinted()).count;
    refusal = { session, minted: after - before };
  } catch (error) {
    checks.push(
      required(
        check(
          "gate off: Rome Cloud refuses a session",
          "not_checked",
          `the environment cannot ask Rome Cloud for a session: ${error.message}`,
        ),
      ),
    );
    return checks;
  }
  const { session, minted } = refusal;
  const refused =
    session.status === 403 && JSON.stringify(session.body).includes("voice_input_not_allowed");
  checks.push(
    required(
      check(
        "gate off: Rome Cloud refuses a session",
        refused && minted === 0 ? "pass" : "fail",
        `POST /v1/transcription/sessions answered ${session.status} ${JSON.stringify(session.body)}; ${minted} credentials minted`,
      ),
    ),
  );
  return checks;
}

/** Waits until Rome's read API says voice input is `wanted`, and returns what it last said. */
async function waitForAvailable(env, message, wanted) {
  const opened = await openPage(env, { mic: message.path, language: browserLanguage(message) });
  try {
    const url = new URL(PLACE_API, opened.page.url()).toString();
    const start = Date.now();
    let available;
    do {
      const response = await opened.page.request.get(url);
      available = response.ok() ? (await response.json()).available : undefined;
      if (available === wanted) break;
      await opened.page.waitForTimeout(2000);
    } while (Date.now() - start < GATE_WAIT_MS);
    return available;
  } finally {
    await opened.close();
  }
}

/** The gate-on half: dictation works with no credential, and Rome Cloud records the seconds. */
async function gateOn(ctx, message) {
  const { env } = ctx;
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
      return [
        required(
          check("gate on: voice control shown", "fail", "the message field shows no voice control"),
        ),
      ];
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
        "gate on: text appears with no credential in the instance",
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
  const off = seconds === undefined ? null : Math.abs(seconds - message.seconds) / message.seconds;
  checks.push(
    required(
      check(
        "gate on: Rome Cloud records the seconds",
        off !== null && off <= SECONDS_TOLERANCE ? "pass" : "fail",
        seconds === undefined
          ? `Rome Cloud shows no new usage within ${USAGE_WAIT_MS / 1000} s of listening stopping`
          : `Rome Cloud records ${seconds} s for a ${message.seconds} s recording (${Math.round(off * 100)}% off); listening lasted ${listened.toFixed(1)} s`,
        [message.key],
      ),
    ),
  );
  return checks;
}

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
