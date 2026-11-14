// Rule 1: you can speak wherever you can type. Every message field has a voice control; one
// action starts listening, the field shows it within 0.5 seconds, and one action stops it. On
// the dashboard and in the desktop app the fields are the Chat (Concierge) and a chat.
import { openPage, voiceForm } from "../lib/product.mjs";
import { setMessages, useTranscriber } from "../lib/runs.mjs";
import { check, required, ruleResult } from "../lib/scenario.mjs";
import { browserLanguage } from "../lib/script.mjs";

/** How soon the field must show listening, and idle again, after the action. */
export const SHOW_MS = 500;
/** Starts and stops per field; every one must be within `SHOW_MS`. */
export const REPEATS = 5;

/** The message fields of the dashboard and the desktop app, by the page that holds each. */
export const FIELDS = [
  { name: "the Chat", path: "/message" },
  { name: "a chat", path: "/chat" },
];

export default {
  rule: "1",
  title: "You can speak wherever you can type",
  phase: 3,
  async run(ctx) {
    await useTranscriber(ctx);
    const message = setMessages(ctx.script, "B").find((m) => m.language === "en");
    const checks = [];
    for (const field of FIELDS) checks.push(required(await checkField(ctx, message, field)));
    return ruleResult(checks);
  },
};

async function checkField(ctx, message, field) {
  const opened = await openPage(ctx.env, {
    mic: message.path,
    path: field.path,
    language: browserLanguage(message),
  });
  try {
    const { page } = opened;
    const form = await voiceForm(page).catch(() => null);
    if (!form) return check(field.name, "fail", "the message field has no voice control");
    const times = [];
    for (let i = 0; i < REPEATS; i++) {
      times.push({
        start: await showsWithin(page, form.control, "true"),
        stop: await showsWithin(page, form.control, "false"),
      });
      // The stop may leave the control finishing; the next start waits until it is idle again.
      await waitIdle(page, form.control);
    }
    const slow = times.flatMap((t, i) =>
      [
        ["start", t.start],
        ["stop", t.stop],
      ]
        .filter(([, ms]) => ms === null || ms > SHOW_MS)
        .map(
          ([what, ms]) =>
            `${what} ${i + 1} ${ms === null ? "never showed" : `showed after ${Math.round(ms)} ms`}`,
        ),
    );
    const all = times.map((t) => `${Math.round(t.start)}/${Math.round(t.stop)}`).join(", ");
    return check(
      field.name,
      slow.length === 0 ? "pass" : "fail",
      slow.length === 0
        ? `${REPEATS} starts and stops each showed within ${SHOW_MS} ms (start/stop ms: ${all})`
        : `${slow.join("; ")}; the bar is ${SHOW_MS} ms`,
    );
  } finally {
    await opened.close();
  }
}

/**
 * Clicks the control and resolves to the milliseconds, in the page's clock, from the click to
 * `aria-pressed` becoming `pressed`, or null when it does not within 3 s.
 */
async function showsWithin(page, control, pressed) {
  await control.evaluate((el, want) => {
    const watch = { clickedAt: null, shownAt: null };
    window.__shows = watch;
    el.addEventListener("click", () => (watch.clickedAt = performance.now()), {
      capture: true,
      once: true,
    });
    const observer = new MutationObserver(() => {
      if (watch.clickedAt !== null && el.getAttribute("aria-pressed") === want) {
        watch.shownAt = performance.now();
        observer.disconnect();
      }
    });
    observer.observe(el, { attributes: true, attributeFilter: ["aria-pressed"] });
  }, pressed);
  await control.click();
  const deadline = Date.now() + 3000;
  for (;;) {
    const watch = await page.evaluate(() => window.__shows);
    if (watch.shownAt !== null) return watch.shownAt - watch.clickedAt;
    if (Date.now() > deadline) return null;
    await page.waitForTimeout(25);
  }
}

/** Waits up to 15 s until the control offers to start again. */
async function waitIdle(page, control) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    const name = `${(await control.getAttribute("aria-label")) ?? ""} ${await control.textContent()}`;
    if (/Start voice input|开始语音输入/.test(name) && !(await control.isDisabled())) return;
    await page.waitForTimeout(100);
  }
}
