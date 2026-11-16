// Rule 13: Enter sends what you said. While listening, Enter ends listening and sends one message
// holding every word heard, words still arriving included, and leaves the field empty. The
// verifier presses Enter just after the last spoken word, before the transcriber has sent it all.
import { CLOSE_MS } from "./r9-mic-open-only-while-listening.mjs";
import { BAR_PER_100 } from "./r3-what-you-said.mjs";
import { fieldText, isListening, openPage, voiceForm, waitForListening } from "../lib/product.mjs";
import { setMessages, useTranscriber, waitForNewMessage } from "../lib/runs.mjs";
import { check, required, ruleResult } from "../lib/scenario.mjs";
import { browserLanguage } from "../lib/script.mjs";
import { errors, errorsWithin, per100, tokens } from "../lib/text.mjs";
import { newMessages } from "../lib/voice-env.mjs";
import { waitForMicClosed, watchPage } from "../lib/watch.mjs";

/** How long after the last spoken word the verifier presses Enter. */
const ENTER_AFTER_WORD_MS = 200;
/** How long the verifier watches for a second message after the first. */
const SECOND_MESSAGE_MS = 2000;

const normalise = (s) => s.replace(/\s+/g, " ").trim();

export default {
  rule: "13",
  title: "Enter sends what you said",
  phase: 4,
  async run(ctx) {
    await useTranscriber(ctx);
    const set = setMessages(ctx.script, "B");
    const messages = ["en", "zh"].map((l) => set.find((m) => m.language === l)).filter(Boolean);
    const checks = [];
    for (const message of messages) {
      try {
        checks.push(...(await enterWhileListening(ctx, message)));
      } catch (error) {
        checks.push(required(check(message.key, "not_checked", `run broke: ${error.message}`)));
      }
    }
    return ruleResult(checks);
  },
};

async function enterWhileListening(ctx, message) {
  const { env, waits } = ctx;
  const standIn = ctx.transcriber === "stand-in";
  if (standIn) await env.transcriber({ mode: "stand-in", text: message.text });
  const opened = await openPage(env, { mic: message.path, language: browserLanguage(message) });
  try {
    const { page } = opened;
    await watchPage(page);
    const { control, field } = await voiceForm(page);
    await field.fill("");
    const before = await env.allMessages();
    const clickedAt = Date.now();
    await control.click();
    await waitForListening(page, control);
    const wait = message.lastWordAt * 1000 + ENTER_AFTER_WORD_MS - (Date.now() - clickedAt);
    if (wait > 0) await page.waitForTimeout(wait);
    const shownAtEnter = await fieldText(field);
    const enterAt = await page.evaluate(() => performance.now());
    await field.press("Enter");
    await waitForNewMessage(env, before, waits);
    await page.waitForTimeout(SECOND_MESSAGE_MS);
    const sent = newMessages(before, await env.allMessages());
    const micClosedMs = await waitForMicClosed(page, enterAt);
    const left = await fieldText(field);
    const listening = await isListening(control);

    const key = message.key;
    const checks = [];
    checks.push(
      required(
        check(
          `${key}: one message`,
          sent.length === 1 ? "pass" : "fail",
          `Enter while listening sent ${sent.length} message(s)`,
          sent.map((m) => m.id),
        ),
      ),
    );
    if (sent.length >= 1) checks.push(required(wordsCheck(key, message, sent[0], standIn)));
    const ended =
      !listening && left.trim() === "" && micClosedMs !== null && micClosedMs <= CLOSE_MS;
    checks.push(
      required(
        check(
          `${key}: listening ends and the field empties`,
          ended ? "pass" : "fail",
          `after Enter the control ${listening ? "still shows" : "no longer shows"} listening, the field holds "${left.trim()}", and the microphone ${micClosedMs === null ? "was still open 3 s later" : `closed ${Math.round(micClosedMs)} ms after Enter; the bar is ${CLOSE_MS} ms`}`,
        ),
      ),
    );
    const still = sent[0] ? normalise(sent[0].text).length - normalise(shownAtEnter).length : 0;
    checks.push(
      check(
        `${key}: words still arriving at Enter`,
        "info",
        still > 0
          ? `the field showed "${normalise(shownAtEnter)}" at Enter, and the message holds ${still} more character(s)`
          : "the field already showed every word at Enter",
      ),
    );
    return checks;
  } finally {
    await opened.close();
  }
}

/**
 * The stand-in transcriber hears its script exactly, so the message must be that text. A real
 * one is held to rule 3's bar, with the last three written words present, which a send that
 * drops the words still arriving would miss.
 */
function wordsCheck(key, message, sent, standIn) {
  const name = `${key}: the message holds every word heard`;
  if (standIn) {
    const same = normalise(sent.text) === normalise(message.text);
    return check(
      name,
      same ? "pass" : "fail",
      same
        ? "the message is the stand-in transcriber's whole text"
        : `the message is "${normalise(sent.text)}", and the stand-in transcriber sent "${normalise(message.text)}"`,
      [sent.id],
    );
  }
  const whole = per100([errors(message.text, sent.text, message.language)]);
  const tail = tokens(message.text, message.language).slice(-3);
  const last = errorsWithin(
    tail.join(message.language === "en" ? " " : ""),
    sent.text,
    message.language,
  );
  const pass = whole <= BAR_PER_100 && last.wrong <= 1;
  return check(
    name,
    pass ? "pass" : "fail",
    `${whole} wrong in 100 against the written text (bar ${BAR_PER_100}); the last three written words "${tail.join(" ")}" came out with ${last.wrong} wrong; the message is "${normalise(sent.text)}"`,
    [sent.id],
  );
}
