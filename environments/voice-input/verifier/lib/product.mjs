// The product as a guardian sees it in Chrome, found only through the contract in the rules
// (rules-V2.md, "Contract between the product and the verifier").
import { resolve } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

// The repo declares Playwright only in the dashboard package, and this folder is no workspace
// of its own, so it borrows that copy instead of adding a second one.
const { chromium } = createRequire(
  fileURLToPath(new URL("../../../../packages/web/package.json", import.meta.url)),
)("@playwright/test");

/** The voice control's accessible names, idle and listening, in English and Simplified Chinese. */
export const VOICE_CONTROL = /^(Start voice input|Stop voice input|开始语音输入|停止语音输入)$/;

/**
 * Starts Chrome through `voice-env browser` with `mic` as the microphone and resolves to
 * `{ page, close }`, where `page` is the dashboard, signed in as the guardian. With `path`,
 * the page goes there on the dashboard first. `close` disconnects. Chrome keeps running, with
 * the environment's capture, until the next `openPage` replaces it or `env.stopBrowser()`.
 */
export async function openPage(env, { mic, path, permission, language }) {
  const { cdp } = await env.browser({ mic, permission, language });
  const browser = await chromium.connectOverCDP(cdp);
  await assertMic(browser, mic).catch(async (error) => {
    await browser.close().catch(() => {});
    throw error;
  });
  const context = browser.contexts()[0] ?? (await browser.newContext());
  const page = context.pages()[0] ?? (await context.newPage());
  if (path) await page.goto(new URL(path, page.url()).toString());
  return {
    page,
    close: () => browser.close().catch(() => {}),
  };
}

/**
 * Throws when the Chrome behind `cdp` plays another recording than `mic`, as when a Chrome left
 * from an earlier run still holds the debugging port. A Chrome started without a recorded
 * microphone, such as the stand-in's, is not checked.
 */
async function assertMic(browser, mic) {
  if (!mic) return;
  const session = await browser.newBrowserCDPSession();
  const { arguments: args } = await session
    .send("Browser.getBrowserCommandLine")
    .catch(() => ({ arguments: [] }));
  const flag = args.find((a) => a.startsWith("--use-file-for-fake-audio-capture="));
  if (flag && !flag.includes(resolve(mic)))
    throw new Error(`the Chrome on the debugging port plays ${flag.split("=")[1]}, not ${mic}`);
}

/**
 * The message form that holds the voice control: `{ control, form, field }`. Throws when the
 * page shows no voice control within `timeoutMs`.
 */
export async function voiceForm(page, { timeoutMs = 15000 } = {}) {
  const control = page.getByRole("button", { name: VOICE_CONTROL }).first();
  await control.waitFor({ state: "visible", timeout: timeoutMs });
  const form = control.locator("xpath=ancestor::form[1]");
  const field = form.getByRole("textbox").first();
  return { control, form, field };
}

/**
 * Waits until the control says it is listening, after the start action. Throws when it does not
 * within `timeoutMs`.
 */
export async function waitForListening(page, control, { timeoutMs = 5000 } = {}) {
  const start = Date.now();
  while (!(await isListening(control))) {
    if (Date.now() - start > timeoutMs)
      throw new Error(
        `the control did not show listening within ${timeoutMs / 1000} s of the start action`,
      );
    await page.waitForTimeout(50);
  }
}

/** Whether the voice control says it is listening, from `aria-pressed`. */
export async function isListening(control) {
  return (await control.getAttribute("aria-pressed")) === "true";
}

/**
 * Starts recording the field's text every 25 ms in the page's own clock, and the time of each
 * click on the voice control. Read the record with `readRecord`.
 */
export async function recordField(field, control) {
  const fieldHandle = await field.elementHandle();
  const controlHandle = await control.elementHandle();
  await fieldHandle.evaluate((el, button) => {
    const rec = { samples: [], clicks: [] };
    window.__voiceRecord = rec;
    const read = () => ("value" in el ? el.value : el.innerText);
    let last = read();
    rec.samples.push([performance.now(), last]);
    button.addEventListener("click", () => rec.clicks.push(performance.now()), true);
    rec.timer = setInterval(() => {
      const now = read();
      if (now !== last) {
        last = now;
        rec.samples.push([performance.now(), now]);
      }
    }, 25);
  }, controlHandle);
}

/** `{ samples: [[ms, text]], clicks: [ms] }` in the page's clock, oldest first. */
export async function readRecord(page) {
  return page.evaluate(() => {
    const { samples, clicks } = window.__voiceRecord;
    return { samples, clicks };
  });
}

export async function pageNow(page) {
  return page.evaluate(() => performance.now());
}

/**
 * After the stop action, waits until the voice control offers to start again, which is when the
 * product has finished with the session and gives the field back. Resolves to the milliseconds
 * that took, or null when it did not happen within `timeoutMs`.
 */
export async function waitForControlReturn(page, control, { timeoutMs = 30000 } = {}) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const name = await control
      .evaluate((el) => `${el.getAttribute("aria-label") ?? ""} ${el.textContent ?? ""}`)
      .catch(() => "");
    if (/Start voice input|开始语音输入/.test(name) && !(await isListening(control)))
      return Date.now() - start;
    await page.waitForTimeout(50);
  }
  return null;
}

/** Waits until the field's text has not changed for `quietMs`, or `timeoutMs` passed. */
export async function waitForSteadyField(page, { quietMs, timeoutMs = 10000 }) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const [{ samples }, now] = [await readRecord(page), await pageNow(page)];
    if (now - samples[samples.length - 1][0] >= quietMs) return;
    await page.waitForTimeout(100);
  }
}

export async function fieldText(field) {
  return field.evaluate((el) => ("value" in el ? el.value : el.innerText));
}
