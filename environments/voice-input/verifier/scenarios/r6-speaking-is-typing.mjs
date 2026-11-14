// Rule 6: speaking words into a field gives the same field, and the same sent message, as
// typing those words at the cursor, with text, a picture and a mention already in the field,
// and one undo removes the spoken words. Typing includes the leading space the contract gives
// spoken text after a character that is neither a space nor Chinese.
import { fileURLToPath } from "node:url";
import { setMessages, useTranscriber, waitForNewMessage } from "../lib/runs.mjs";
import { check, required, ruleResult } from "../lib/scenario.mjs";
import { browserLanguage } from "../lib/script.mjs";
import { newMessages } from "../lib/voice-env.mjs";
import {
  fieldText,
  isListening,
  openPage,
  recordField,
  voiceForm,
  waitForSteadyField,
} from "../lib/product.mjs";

const PICTURE = fileURLToPath(new URL("../fixtures/picture.png", import.meta.url));

/**
 * The five cases. `setup` puts the field in its starting state through the same actions a
 * guardian would use, and leaves the cursor where the spoken words go.
 */
export const CASES = [
  { name: "empty field", setup: async () => {} },
  {
    name: "text, cursor at the end",
    setup: async ({ page, field }) => {
      await field.click();
      await page.keyboard.type("Please remind me");
    },
  },
  {
    name: "text, cursor in the middle",
    setup: async ({ page, field }) => {
      await field.click();
      await page.keyboard.type("Before  after");
      for (let i = 0; i < "after".length + 1; i++) await page.keyboard.press("ArrowLeft");
    },
  },
  {
    name: "a picture attached",
    needs: "a file input in the message form",
    setup: async ({ form, field }) => {
      await form.locator('input[type="file"]').first().setInputFiles(PICTURE, { timeout: 5000 });
      await field.click();
    },
  },
  {
    name: "a mention",
    // Only a new common chat, not yet bound to an agent, offers mentions.
    path: "/chat",
    needs: "a new common chat whose @ menu offers an app with an agent",
    setup: async ({ page, field }) => {
      await field.click();
      await page.keyboard.type("@");
      const option = page.getByRole("option").first();
      await option.waitFor({ state: "visible", timeout: 5000 });
      // The menu lists apps first; Enter on an app lists its agents, and Enter on an agent picks it.
      await page.keyboard.press("Enter");
      await option.waitFor({ state: "visible", timeout: 5000 });
      await page.keyboard.press("Enter");
    },
  },
];

export default {
  rule: "6",
  title: "Speaking is typing",
  phase: 1,
  async run(ctx) {
    await useTranscriber(ctx);
    const message = setMessages(ctx.script, "B")[0];
    if (ctx.transcriber === "stand-in")
      await ctx.env.transcriber({ mode: "stand-in", text: message.text });
    const checks = [];
    for (const c of CASES) {
      checks.push(required(await runCase(ctx, message, c)));
      ctx.log(`rule 6 ${c.name}: ${checks.at(-1).status}`);
    }
    return ruleResult(checks);
  },
};

async function runCase(ctx, message, testCase) {
  let voice;
  try {
    voice = await pass(ctx, message, testCase, "voice");
  } catch (error) {
    return setupFailure(testCase, error);
  }
  if (voice.spoken === null) {
    return check(
      testCase.name,
      "fail",
      `the field after speaking ("${voice.after}") is not the starting field ("${voice.before}") with words added at the cursor`,
      [voice.sent?.id],
    );
  }
  if (voice.spoken.trim() === "") return check(testCase.name, "fail", "speaking added no words");
  const lead = expectedLead(voice.before, voice.cursor);
  if (!voice.spoken.startsWith(lead) || /^\s/.test(voice.spoken.slice(lead.length))) {
    return check(
      testCase.name,
      "fail",
      `the spoken text "${voice.spoken}" should start with ${lead ? "one space" : "no space"} after "${voice.before.slice(0, voice.cursor)}"`,
      [voice.sent?.id],
    );
  }
  let typed;
  let undo;
  try {
    typed = await pass(ctx, message, testCase, "typing", voice.spoken);
    undo = await pass(ctx, message, testCase, "undo");
  } catch (error) {
    return setupFailure(testCase, error);
  }
  const problems = [];
  if (typed.after !== voice.after)
    problems.push(`typing gave the field "${typed.after}", speaking gave "${voice.after}"`);
  if (!sameMessage(voice.sent, typed.sent))
    problems.push(
      `the sent messages differ: by voice ${describe(voice.sent)}, by typing ${describe(typed.sent)}`,
    );
  if (undo.after !== undo.before)
    problems.push(`one undo left "${undo.after}" where the field was "${undo.before}"`);
  return check(
    testCase.name,
    problems.length === 0 ? "pass" : "fail",
    problems.length === 0
      ? `spoke "${voice.spoken.trim()}"; same field and message as typing; one undo removed it`
      : problems.join("; "),
    [voice.sent?.id, typed.sent?.id],
  );
}

function setupFailure(testCase, error) {
  const detail = testCase.needs
    ? `could not set up the case (needs ${testCase.needs}): ${error.message}`
    : `run broke: ${error.message}`;
  return check(testCase.name, "not_checked", detail);
}

/**
 * One pass over a case in a new Chrome. `voice` speaks and sends, `typing` types `words` at the
 * cursor and sends, `undo` speaks and presses undo once. Resolves to `{ before, after,
 * spoken, sent }`, where `spoken` is the text added at the cursor, or null when the change is
 * not an insertion at the cursor.
 */
async function pass(ctx, message, testCase, mode, words) {
  const { env, waits } = ctx;
  const opened = await openPage(env, {
    mic: message.path,
    path: testCase.path,
    language: browserLanguage(message),
  });
  try {
    const { page } = opened;
    const { control, form, field } = await voiceForm(page);
    await testCase.setup({ page, form, field });
    const before = await fieldText(field);
    const cursor = await field.evaluate((el) => el.selectionStart ?? el.value.length);
    if (mode === "typing") {
      await field.focus();
      await page.keyboard.type(words);
    } else {
      await recordField(field, control);
      await control.click();
      await page.waitForTimeout(message.lastWordAt * 1000 + waits.afterSpeechMs);
      if (await isListening(control)) await control.click();
      await waitForSteadyField(page, { quietMs: waits.steadyMs });
    }
    if (mode === "undo") {
      await field.focus();
      await page.keyboard.press("ControlOrMeta+z");
      return { before, after: await fieldText(field) };
    }
    const after = await fieldText(field);
    const sentBefore = await env.allMessages();
    await field.press("Enter");
    const [sent = null] = newMessages(sentBefore, await waitForNewMessage(env, sentBefore, waits));
    return { before, after, cursor, spoken: insertedAt(before, after, cursor), sent };
  } finally {
    await opened.close();
  }
}

/** The text added to `before` at `cursor` to give `after`, or null when that is not the change. */
export function insertedAt(before, after, cursor) {
  const head = before.slice(0, cursor);
  const tail = before.slice(cursor);
  if (after.length < before.length || !after.startsWith(head) || !after.endsWith(tail)) return null;
  return after.slice(head.length, after.length - tail.length);
}

/**
 * The contract's leading space: one space before spoken text when the character before the
 * cursor is neither a space nor a Chinese character.
 */
export function expectedLead(before, cursor) {
  const prev = before.slice(0, cursor).slice(-1);
  return prev === "" || /\s/.test(prev) || /[\u3400-\u9fff\uf900-\ufaff]/u.test(prev) ? "" : " ";
}

function sameMessage(a, b) {
  if (!a || !b) return false;
  const files = (m) =>
    (m.attachments ?? [])
      .map((f) => `${f.type}:${f.name}`)
      .sort()
      .join(",");
  return sameText(a.text) === sameText(b.text) && files(a) === files(b);
}

/**
 * The text with each stored file's link reduced to its name. The same picture attached twice
 * is stored twice, under two links, so the links differ between the voice and typing passes.
 */
function sameText(text) {
  return (text ?? "").replace(/\(<?\/api\/assets\/[0-9a-f]+(\.\w+)?>?\)/g, "(asset$1)");
}

function describe(m) {
  if (!m) return "none sent";
  return `"${m.text}" with ${(m.attachments ?? []).length} attachment(s)`;
}
