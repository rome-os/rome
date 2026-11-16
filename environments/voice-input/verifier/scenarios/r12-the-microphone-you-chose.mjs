// Rule 12: listening uses the microphone you chose. Settings lists every microphone the browser
// offers, and listening in a message field captures from the one chosen there, also after a
// reload. Chrome's fake media device offers three microphones that play the same recording, so
// the verifier reads which one listening opened from its capture track, never from the sound.
import { SETTINGS_PATH } from "./r10-voice-goes-where-named.mjs";
import {
  isListening,
  openPage,
  voiceForm,
  waitForControlReturn,
  waitForListening,
} from "../lib/product.mjs";
import { setMessages, useTranscriber } from "../lib/runs.mjs";
import { check, notChecked, required, ruleResult } from "../lib/scenario.mjs";
import { micState, watchPage } from "../lib/watch.mjs";

/** The microphone control's accessible name on the Settings page, in English and Chinese. */
export const MICROPHONE_CONTROL = /^(Microphone|麦克风)$/;

/** Browser ids that stand for another device rather than being one. */
const ALIASES = new Set(["default", "communications"]);

export default {
  rule: "12",
  title: "Listening uses the microphone you chose",
  phase: 4,
  async run(ctx) {
    await useTranscriber(ctx);
    const mic = setMessages(ctx.script, "B")[0].path;
    const opened = await openPage(ctx.env, { mic, path: SETTINGS_PATH });
    try {
      const { page } = opened;
      await watchPage(page);
      const devices = (
        await page.evaluate(async () =>
          (
            await navigator.mediaDevices.enumerateDevices()
          )
            .filter((d) => d.kind === "audioinput")
            .map(({ deviceId, label }) => ({ deviceId, label })),
        )
      ).filter((d) => !ALIASES.has(d.deviceId));
      if (devices.length < 2)
        return notChecked(`the browser offers ${devices.length} microphone(s); the rule needs two`);
      const picker = await findPicker(page);
      if (!picker)
        return ruleResult([
          required(
            check(
              "Settings lists the microphones",
              "fail",
              "Settings has no control named Microphone",
            ),
          ),
        ]);
      const names = await optionNames(page, picker);
      const missing = devices.filter((d) => !names.some((n) => n.includes(d.label)));
      const checks = [
        required(
          check(
            "Settings lists the microphones",
            missing.length === 0 ? "pass" : "fail",
            missing.length === 0
              ? `the Microphone control offers all ${devices.length}: ${devices.map((d) => d.label).join(", ")}`
              : `the Microphone control lacks ${missing.map((d) => d.label).join(", ")}; it offers ${names.join(", ")}`,
          ),
        ),
      ];
      // The first device is the browser's default, so choosing it would prove nothing.
      for (const device of devices.slice(1)) {
        const name = `listening uses "${device.label}"`;
        try {
          await page.goto(new URL(SETTINGS_PATH, page.url()).toString());
          await choose(page, await findPicker(page), device.label);
          await page.goto(new URL("/", page.url()).toString());
          checks.push(required(await listensWith(page, name, device)));
          await page.reload();
          checks.push(required(await listensWith(page, `${name}, after a reload`, device)));
        } catch (error) {
          checks.push(required(check(name, "not_checked", `could not run: ${error.message}`)));
        }
      }
      return ruleResult(checks);
    } finally {
      await opened.close();
    }
  },
};

/** The Settings page's Microphone control, or null when the page shows none within 15 s. */
async function findPicker(page) {
  const picker = page.getByRole("combobox", { name: MICROPHONE_CONTROL }).first();
  return picker
    .waitFor({ state: "visible", timeout: 15000 })
    .then(() => picker)
    .catch(() => null);
}

/** The names of the control's options, a native select's or a listbox's. */
async function optionNames(page, picker) {
  if ((await picker.evaluate((el) => el.tagName)) === "SELECT")
    return (await picker.locator("option").allTextContents()).map((t) => t.trim());
  await picker.click();
  const names = (await page.getByRole("option").allTextContents()).map((t) => t.trim());
  await page.keyboard.press("Escape");
  return names;
}

/** Chooses the option holding `label`, the way a guardian does, and gives the save a moment. */
async function choose(page, picker, label) {
  if ((await picker.evaluate((el) => el.tagName)) === "SELECT") {
    const value = await picker
      .locator("option")
      .filter({ hasText: label })
      .first()
      .getAttribute("value");
    await picker.selectOption(value);
  } else {
    await picker.click();
    await page.getByRole("option").filter({ hasText: label }).first().click();
  }
  await page.waitForTimeout(1000);
}

/** Starts listening in the chat's message field and reads which microphone the capture opened. */
async function listensWith(page, name, device) {
  const { control } = await voiceForm(page);
  const before = (await micState(page)).tracks.length;
  await control.click();
  await waitForListening(page, control);
  await page.waitForTimeout(500);
  const opened = (await micState(page)).tracks.slice(before);
  if (await isListening(control)) await control.click();
  await waitForControlReturn(page, control);
  if (opened.length === 0) return check(name, "fail", "listening opened no audio capture track");
  const wrong = opened.filter((t) => t.deviceId !== device.deviceId);
  return check(
    name,
    wrong.length === 0 ? "pass" : "fail",
    wrong.length === 0
      ? `listening captured from "${device.label}"`
      : `"${device.label}" was chosen, and listening captured from ${wrong.map((t) => `"${t.label}"`).join(", ")}`,
  );
}
