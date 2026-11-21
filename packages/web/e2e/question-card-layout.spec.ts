import { expect, test } from "@playwright/test";
import { expectQuestionCardContained } from "./question-card-layout";

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("i18nextLng", "en"));
  await page.goto("/dev/chat-entries");
  await expect(page.locator("#question-card-cjk [data-widget-app]")).toBeVisible({
    timeout: 30_000,
  });
  await page.evaluate(() => document.fonts.ready);
});

for (const width of [320, 375, 390, 768, 1440]) {
  test(`question cards contain labels and inputs at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    for (const card of await page.locator("[id^=question-card] [data-widget-app]").all()) {
      await expectQuestionCardContained(card);
    }
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
      ),
    ).toBe(true);
  });
}

test("compact options wrap inside a narrow desktop pane and recover at full width", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const card = page.locator("#question-card-cjk [data-widget-app]");
  const option = card.getByRole("button", {
    name: "按当前语言只显示对应的那一半（中文取「/」前，英文取后）",
    exact: true,
  });
  const wideHeight = (await option.boundingBox())!.height;
  for (const width of [260, 180]) {
    await card.evaluate((el, width) => {
      el.parentElement!.style.width = `${width}px`;
    }, width);
    await expectQuestionCardContained(card);
    expect((await option.boundingBox())!.height).toBeGreaterThan(wideHeight);
  }
  await card.evaluate((el) => {
    el.parentElement!.style.removeProperty("width");
  });
  await expectQuestionCardContained(card);
  expect((await option.boundingBox())!.height).toBe(wideHeight);
});

test("wrapped options remain keyboard-selectable and submit without overflow", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 900 });
  const card = page.locator("#question-card-cjk");
  const first = card.getByRole("button", {
    name: "要，中文 + 英文，默认跟随 Rome 界面语言",
    exact: true,
  });
  await first.focus();
  await page.keyboard.press("Space");
  await expect(first).toHaveAttribute("aria-pressed", "true");
  await card.getByRole("button", { name: "保持原样双语显示", exact: true }).click();
  await card.getByPlaceholder("Add your own…").fill("An additional answer");
  await card.getByRole("button", { name: "Send", exact: true }).click();
  await expect(first).toBeDisabled();
  await expect(card.getByRole("button", { name: "Send", exact: true })).toHaveCount(0);
  await expectQuestionCardContained(card.locator("[data-widget-app]"));
});
