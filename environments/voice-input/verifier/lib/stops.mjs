// The ways listening stops other than the guardian's stop action, as rule 7 lists them for the
// dashboard. Each stop is run once per run and kept in `ctx.memo.stops`, so rule 9 reads the
// microphone's closing from the same stops instead of running them again.
import {
  fieldText,
  isListening,
  openPage,
  readRecord,
  recordField,
  voiceForm,
  waitForListening,
} from "./product.mjs";
import { setMessages, useTranscriber } from "./runs.mjs";
import { browserLanguage } from "./script.mjs";
import { errorsWithin } from "./text.mjs";
import { waitForMicClosed, waitForNotice, watchPage } from "./watch.mjs";

/** The checked stops on the dashboard, with the notice the contract gives each in English. */
export const STOPS = [
  { kind: "another chat", expected: "Listening stopped when you left this chat" },
  { kind: "reload", expected: "Listening stopped when the page reloaded" },
  { kind: "network", expected: "Connection to Rome lost. Listening stopped" },
  // The contract gives no wording for a transcriber error, only that the field says why.
  { kind: "transcriber error", expected: null },
];

/** How long the notice may take to show. */
export const NOTICE_MS = 5000;
/** The stand-in's error, and when into the session it comes. */
const ERROR = { code: 503, type: "service_unavailable" };

/**
 * Every stop's outcome, run once per run. Each is `{ kind, before, after, notice, noticeMs,
 * micClosedMs, transcriber, error }`; `error` is set when the stop could not be run.
 */
export async function runStops(ctx) {
  if (ctx.memo.stops) return ctx.memo.stops;
  const message = setMessages(ctx.script, "B").find((m) => m.language === "en");
  const outcomes = [];
  for (const stop of STOPS) {
    try {
      outcomes.push({ ...stop, ...(await runStop(ctx, message, stop)) });
    } catch (error) {
      outcomes.push({ ...stop, error: error.message });
    }
    ctx.log(`stop ${stop.kind}: ${outcomes.at(-1).error ?? "done"}`);
  }
  ctx.memo.stops = { message, outcomes };
  return ctx.memo.stops;
}

async function runStop(ctx, message, stop) {
  const { env } = ctx;
  // A transcriber error can only be caused at the stand-in; the other stops use the run's.
  const onStandIn = stop.kind === "transcriber error";
  const midway = (message.firstWordAt + message.lastWordAt) / 2;
  if (onStandIn) {
    await env.transcriber({
      mode: "stand-in",
      text: message.text,
      errorCode: ERROR.code,
      afterMs: Math.round((midway - message.firstWordAt) * 1000),
    });
    ctx.memo.transcriberSet = false;
  } else {
    await useTranscriber(ctx);
  }
  const opened = await openPage(env, { mic: message.path, language: browserLanguage(message) });
  try {
    const { page } = opened;
    await watchPage(page);
    let { control, form, field } = await voiceForm(page);
    await recordField(field, control);
    await control.click();
    const startedAt = await page.evaluate(() => performance.now());
    await waitForListening(page, control);
    let stoppedAt;
    if (onStandIn) {
      // The stop is the product's own, when listening ends after the error.
      const deadline = Date.now() + (message.lastWordAt + 15) * 1000;
      while ((await isListening(control)) && Date.now() < deadline) await page.waitForTimeout(50);
      if (await isListening(control))
        throw new Error("listening went on after the transcriber's error");
      stoppedAt = await page.evaluate(() => performance.now());
    } else {
      await page.waitForTimeout(midway * 1000);
      // Words must be in the field before the stop for the stop to test anything.
      const deadline = Date.now() + 5000;
      while (!(await fieldText(field)).trim() && Date.now() < deadline)
        await page.waitForTimeout(100);
    }
    // For the product's own stop, the record holds the field as it was when listening ended.
    const before = onStandIn ? lastText(await readRecord(page), stoppedAt) : await fieldText(field);
    if (!onStandIn) stoppedAt = await page.evaluate(() => performance.now());

    let micClosedMs;
    let since = stoppedAt;
    if (stop.kind === "another chat") {
      const away = await openAnotherChat(page);
      micClosedMs = await waitForMicClosed(page, stoppedAt);
      await page.goBack();
      await page.waitForURL((url) => url.toString() === away.from, { timeout: 10000 });
      since = await page.evaluate(() => performance.now());
    } else if (stop.kind === "reload") {
      await page.reload();
      // The old page's microphone ended with it; a new one must not open by itself.
      await page.waitForTimeout(1000);
      micClosedMs = (await waitForMicClosed(page, 0, { timeoutMs: 0 })) === null ? null : 0;
      since = 0;
    } else if (stop.kind === "network") {
      await env.network("cut");
      try {
        micClosedMs = await waitForMicClosed(page, stoppedAt);
        ({ control, form, field } = await voiceForm(page));
        const notice = await waitForNotice(page, form, since, { timeoutMs: NOTICE_MS });
        return await finish({ before, field, notice, micClosedMs, ctx, onStandIn });
      } finally {
        await env.network("restore");
      }
    } else {
      micClosedMs = await waitForMicClosed(page, stoppedAt);
    }
    ({ control, form, field } = await voiceForm(page));
    const notice = await waitForNotice(page, form, since, { timeoutMs: NOTICE_MS });
    return await finish({ before, field, notice, micClosedMs, ctx, onStandIn });
  } finally {
    await opened.close();
    if (onStandIn) await useTranscriber(ctx);
  }
}

async function finish({ before, field, notice, micClosedMs, ctx, onStandIn }) {
  return {
    before,
    after: await fieldText(field),
    notice: notice?.text ?? null,
    noticeMs: notice?.ms ?? null,
    micClosedMs,
    transcriber: onStandIn ? "the stand-in, answering with an error" : describeInUse(ctx),
  };
}

function describeInUse(ctx) {
  const named = ctx.memo.transcriberInUse?.named;
  return named ? `${named.provider} at ${named.host}` : ctx.transcriber;
}

/** The field's text last recorded at or before `at` (page clock), or the latest when `at` is unset. */
function lastText({ samples }, at) {
  const upTo = at === undefined ? samples : samples.filter(([t]) => t <= at);
  return (upTo.at(-1) ?? samples[0])[1];
}

/**
 * Opens another chat the way a guardian does, by its link on the dashboard, and resolves to
 * `{ from, to }`. Throws when the page links to no other chat.
 */
export async function openAnotherChat(page) {
  const from = page.url();
  const here = new URL(from).pathname;
  const hrefs = await page
    .locator("a[href]")
    .evaluateAll((links) => links.map((a) => a.getAttribute("href")));
  const to = hrefs.find((href) => {
    const path = new URL(href, from).pathname;
    return /\/chats?\/[^/]+$/.test(path) && path !== here;
  });
  if (!to) throw new Error("the page links to no other chat");
  await page.locator(`a[href="${to}"]`).first().click();
  await page.waitForURL((url) => url.pathname !== here, { timeout: 10000 });
  return { from, to: page.url() };
}

/**
 * Whether the words heard before the stop are in the field: at most one in ten of them may be
 * wrong, since the transcriber may still correct words it had not finalised.
 */
export function wordsKept(before, after, language) {
  const found = errorsWithin(before, after, language);
  return { ...found, kept: found.of > 0 && found.wrong <= Math.floor(found.of / 10) };
}
