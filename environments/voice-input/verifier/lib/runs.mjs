// The 20 script runs that rules 2, 3, 5 and 10 score. They run once per verify run, whichever
// of those rules asks first, with the environment capturing traffic throughout.
import { browserLanguage } from "./script.mjs";
import { newMessages } from "./voice-env.mjs";
import {
  fieldText,
  isListening,
  openPage,
  readRecord,
  recordField,
  voiceForm,
  waitForSteadyField,
} from "./product.mjs";

/**
 * Plays every script message into the dashboard's message field and records, for each:
 * `{ key, language, written, heard, clickAt, samples, firstWordAt, lastWordAt,
 *    newAfterWait, sent, error }`.
 * `samples` are `[ms, text]` in the page's clock and `clickAt` is the start click in the same
 * clock. `newAfterWait` are the messages, in any chat, that appeared between the start click
 * and `waits.sendCheckMs` after listening stopped. `sent` are those that appeared after the
 * send action, the guardian's first. A message whose run broke carries `error` and nothing else to score.
 */
export async function scriptRuns(ctx) {
  if (ctx.memo.scriptRuns) return ctx.memo.scriptRuns;
  const { env, script } = ctx;
  await useTranscriber(ctx);
  const runs = [];
  // The environment records a browser's traffic only once a browser runs.
  const first = await openPage(env, { mic: script.messages[0].path });
  await env.captureStart();
  await first.close();
  try {
    for (const message of script.messages) {
      if (ctx.transcriber === "stand-in")
        await env.transcriber({ mode: "stand-in", text: message.text });
      runs.push(await runOne(ctx, message));
      ctx.log(`${message.key}: ${runs[runs.length - 1].error ?? "done"}`);
    }
  } finally {
    ctx.memo.capture = await env.captureStop();
  }
  ctx.memo.scriptRuns = { runs };
  return ctx.memo.scriptRuns;
}

/** Points Rome at the transcriber this run uses. */
export async function useTranscriber(ctx) {
  await ctx.env.transcriber({ mode: ctx.transcriber });
}

async function runOne(ctx, message) {
  const { env, waits } = ctx;
  const base = {
    key: message.key,
    language: message.language,
    written: message.text,
    firstWordAt: message.firstWordAt,
    lastWordAt: message.lastWordAt,
  };
  let opened;
  try {
    opened = await openPage(env, {
      mic: message.path,
      language: browserLanguage(message),
    });
    const { page } = opened;
    const { control, field } = await voiceForm(page);
    await recordField(field, control);
    const before = await env.allMessages();
    await control.click();
    await page.waitForTimeout(message.lastWordAt * 1000 + waits.afterSpeechMs);
    if (await isListening(control)) await control.click();
    await waitForSteadyField(page, { quietMs: waits.steadyMs });
    const record = await readRecord(page);
    const heard = await fieldText(field);
    await page.waitForTimeout(waits.sendCheckMs);
    const afterWait = await env.allMessages();
    await field.press("Enter");
    const afterSend = await waitForNewMessage(env, afterWait, waits);
    return {
      ...base,
      heard,
      clickAt: record.clicks[0],
      samples: record.samples,
      newAfterWait: newMessages(before, afterWait),
      sent: newMessages(afterWait, afterSend),
    };
  } catch (error) {
    return { ...base, error: error.message };
  } finally {
    await opened?.close();
  }
}

/** Every message once one is new since `before`, or after `waits.sendMs`. */
export async function waitForNewMessage(env, before, waits) {
  const start = Date.now();
  for (;;) {
    const messages = await env.allMessages();
    if (newMessages(before, messages).length > 0 || Date.now() - start >= waits.sendMs)
      return messages;
    await new Promise((r) => setTimeout(r, Math.min(250, waits.sendMs)));
  }
}

/**
 * When text first appeared and when it last changed, in seconds after the start click, from
 * a run's field samples. `null` when no text appeared.
 */
export function textTimes(run) {
  const atClick = run.samples.filter(([t]) => t <= run.clickAt).at(-1)?.[1] ?? "";
  const changes = run.samples.filter(([t, text]) => t > run.clickAt && text !== atClick);
  if (changes.length === 0) return null;
  return {
    firstTextAt: (changes[0][0] - run.clickAt) / 1000,
    completeAt: (changes[changes.length - 1][0] - run.clickAt) / 1000,
  };
}
