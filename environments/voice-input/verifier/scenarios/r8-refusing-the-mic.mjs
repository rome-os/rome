// Rule 8: refusing the microphone costs you nothing else. The first use gives a reason in plain
// words, in English and Simplified Chinese. With the microphone refused, the control stays
// visible, using it says how to allow the microphone, and a typed message still sends.
import { fieldText, openPage, voiceForm } from "../lib/product.mjs";
import { setMessages, waitForNewMessage } from "../lib/runs.mjs";
import { check, required, ruleResult } from "../lib/scenario.mjs";
import { newMessages } from "../lib/voice-env.mjs";
import { noticesSince, waitForNotice, watchPage } from "../lib/watch.mjs";

/** The contract's words for each language. The refused notice has English wording only. */
export const WORDS = {
  en: {
    reason: "Rome uses the microphone to turn your speech into text",
    blocked: (text) => text === "Microphone blocked. Allow it in the browser's site settings",
    blockedSays: `"Microphone blocked. Allow it in the browser's site settings"`,
    typed: "A typed message with the microphone refused",
  },
  "zh-CN": {
    reason: "Rome 使用麦克风将你的语音转成文字",
    // No Chinese wording is in the contract: it must be Chinese and say to allow (允许) it.
    blocked: (text) => /[一-鿿]/u.test(text) && text.includes("允许"),
    blockedSays: "Chinese text that says to allow (允许) the microphone",
    typed: "麦克风被拒绝时输入的消息",
  },
};

export default {
  rule: "8",
  title: "Refusing the microphone costs you nothing else",
  phase: 2,
  async run(ctx) {
    const mic = setMessages(ctx.script, "B")[0].path;
    const checks = [];
    for (const language of Object.keys(WORDS)) {
      checks.push(required(await firstUse(ctx, mic, language)));
      checks.push(...(await refused(ctx, mic, language)).map(required));
    }
    return ruleResult(checks);
  },
};

/** With the permission unset, starting gives the reason while the browser's prompt is open. */
async function firstUse(ctx, mic, language) {
  const name = `${language}: the first use gives the reason`;
  const opened = await openPage(ctx.env, { mic, permission: "unset", language });
  try {
    const { page } = opened;
    await watchPage(page);
    const state = await page.evaluate(() =>
      navigator.permissions.query({ name: "microphone" }).then((p) => p.state),
    );
    if (state !== "prompt")
      return check(
        name,
        "not_checked",
        `the browser's microphone permission is ${state}, not unset`,
      );
    const { control, form } = await voiceForm(page);
    const at = await page.evaluate(() => performance.now());
    await control.click();
    await waitForNotice(page, form, at, { timeoutMs: 3000 });
    // Headless Chrome may answer its own prompt at once, so the line can be gone already: every
    // line shown since the start action counts.
    const shown = await noticesSince(page, at);
    const want = WORDS[language].reason;
    const reason = shown.find(([, text]) => text.includes(want));
    return check(
      name,
      reason ? "pass" : "fail",
      shown.length > 0
        ? `after the start action the field said ${shown.map(([t, text]) => `"${text}" at ${Math.round(t - at)} ms`).join(", then ")}; the contract gives "${want}"`
        : `no line in the field within 3 s of the start action; the contract gives "${want}"`,
    );
  } finally {
    await opened.close();
  }
}

/** With the permission refused: the control stays, using it says how to allow, typing sends. */
async function refused(ctx, mic, language) {
  const words = WORDS[language];
  const opened = await openPage(ctx.env, { mic, permission: "refused", language });
  try {
    const { page } = opened;
    await watchPage(page);
    const form = await voiceForm(page).catch(() => null);
    if (!form)
      return [
        check(`${language}: the control stays visible`, "fail", "the page shows no voice control"),
      ];
    const checks = [
      check(`${language}: the control stays visible`, "pass", "the voice control is shown"),
    ];
    const at = await page.evaluate(() => performance.now());
    await form.control.click();
    const notice = await waitForNotice(page, form.form, at);
    checks.push(
      check(
        `${language}: using it says how to allow the microphone`,
        notice && words.blocked(notice.text) ? "pass" : "fail",
        notice
          ? `the field says "${notice.text}"; wanted ${words.blockedSays}`
          : `no line in the field within 5 s; wanted ${words.blockedSays}`,
      ),
    );
    await form.field.fill("");
    await form.field.focus();
    await page.keyboard.type(words.typed);
    const before = await ctx.env.allMessages();
    await form.field.press("Enter");
    const [sent] = newMessages(before, await waitForNewMessage(ctx.env, before, ctx.waits));
    const left = await fieldText(form.field);
    checks.push(
      check(
        `${language}: a typed message still sends`,
        sent?.text?.includes(words.typed) ? "pass" : "fail",
        sent
          ? `sent "${sent.text}"; the field then held "${left}"`
          : `no message sent within ${ctx.waits.sendMs / 1000} s of Enter`,
        [sent?.id],
      ),
    );
    return checks;
  } finally {
    await opened.close();
  }
}
