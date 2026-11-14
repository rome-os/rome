// The script runs the rules score, once per set per verify run, whichever rule asks first.
// Set B (20 messages worded for an assistant) serves rules 2, 3, 5 and 10, with the
// environment capturing traffic throughout. Set A (public real-speech recordings) serves only
// rule 3, so its runs skip the send checks.
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
 *    newAfterWait, sent, error }`; set A runs stop at `samples`.
 * `samples` are `[ms, text]` in the page's clock and `clickAt` is the start click in the same
 * clock. `newAfterWait` are the messages, in any chat, that appeared between the start click
 * and `waits.sendCheckMs` after listening stopped. `sent` are those that appeared after the
 * send action, the guardian's first. A message whose run broke carries `error` and nothing else to score.
 */
export async function scriptRuns(ctx, set = "B") {
  ctx.memo.scriptRuns ??= {};
  if (ctx.memo.scriptRuns[set]) return ctx.memo.scriptRuns[set];
  const { env } = ctx;
  const messages = setMessages(ctx.script, set);
  await useTranscriber(ctx);
  const runs = [];
  const capture = set === "B";
  if (capture) {
    // The environment records a browser's traffic only once a browser runs.
    const first = await openPage(env, { mic: messages[0].path });
    await env.captureStart();
    await first.close();
  }
  try {
    for (const message of messages) {
      if (ctx.transcriber === "stand-in")
        await env.transcriber({ mode: "stand-in", text: message.text });
      runs.push(await runOne(ctx, message, { checkSend: capture }));
      ctx.log(`${message.key}: ${runs[runs.length - 1].error ?? "done"}`);
    }
  } finally {
    if (capture) ctx.memo.capture = await env.captureStop();
  }
  ctx.memo.scriptRuns[set] = { runs };
  return ctx.memo.scriptRuns[set];
}

/** The script messages of one set, in order. */
export function setMessages(script, set) {
  return script.messages.filter((m) => (m.set ?? "A") === set);
}

/**
 * Points Rome at the transcriber this run uses, once per verify run, since switching
 * restarts Rome. Throws "no provider credential" when the environment has no key for it.
 */
export async function useTranscriber(ctx) {
  if (ctx.memo.transcriberSet) return;
  try {
    await ctx.env.transcriber({ mode: ctx.transcriber });
  } catch (error) {
    if (/API_KEY/.test(error.message)) throw new Error(`no provider credential (${error.message})`);
    throw error;
  }
  ctx.memo.transcriberSet = true;
  ctx.memo.transcriberInUse = await transcriberInUse(ctx);
}

/**
 * What speech actually goes to once the transcriber is set: the environment's transcriber, and
 * the provider and host Rome names, which on the Rome Cloud path come from Rome Cloud.
 */
async function transcriberInUse(ctx) {
  const environment = (await ctx.env.version())?.transcriber ?? null;
  const opened = await openPage(ctx.env, { mic: setMessages(ctx.script, "B")[0].path });
  try {
    const url = new URL("/api/voice-input", opened.page.url()).toString();
    const response = await opened.page.request.get(url);
    const body = response.ok() ? await response.json().catch(() => null) : null;
    return { environment, named: body?.place ?? null, via: body?.via ?? null };
  } finally {
    await opened.close();
  }
}

/**
 * Why speech is not reaching a real provider, or null when it is. Rules 2 and 3 measure the
 * provider, so they refuse the stand-in even when a real transcriber was asked for.
 */
export function standInReason(ctx) {
  if (ctx.transcriber === "stand-in") return "the stand-in transcriber was asked for";
  const used = ctx.memo.transcriberInUse;
  if (!used) return null;
  if (used.environment?.provider === "stand-in")
    return `the environment's transcriber is the stand-in at ${used.environment.url}, though ${ctx.transcriber} was asked for`;
  if (/^transcriber(:\d+)?$/.test(used.named?.host ?? ""))
    return `Rome names ${used.named.provider} at ${used.named.host}, the stand-in's host`;
  return null;
}

async function runOne(ctx, message, { checkSend }) {
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
    const result = { ...base, heard, clickAt: record.clicks[0], samples: record.samples };
    if (!checkSend) {
      // Leave no draft behind for the next message.
      await field.fill("");
      return result;
    }
    await page.waitForTimeout(waits.sendCheckMs);
    const afterWait = await env.allMessages();
    await field.press("Enter");
    const afterSend = await waitForNewMessage(env, afterWait, waits);
    return {
      ...result,
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
