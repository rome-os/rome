import { expect, test } from "@playwright/test";
import { expectQuestionCardContained } from "./question-card-layout";

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("i18nextLng", "en"));
  await page.goto("/dev/chat-blocks");
  await expect(page.locator("#question-card-cjk fieldset")).toBeVisible({ timeout: 30_000 });
  await page.evaluate(() => document.fonts.ready);
});

for (const width of [320, 375, 390, 768, 1440]) {
  test(`question cards contain labels and inputs at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    for (const fieldset of await page.locator("fieldset").all()) {
      await expectQuestionCardContained(fieldset);
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
  const fieldset = page.locator("#question-card-cjk fieldset");
  const option = fieldset.getByRole("button", {
    name: "按当前语言只显示对应的那一半（中文取「/」前，英文取后）",
    exact: true,
  });
  const wideHeight = (await option.boundingBox())!.height;
  for (const width of [260, 180]) {
    await fieldset.evaluate((el, width) => {
      el.parentElement!.style.width = `${width}px`;
    }, width);
    await expectQuestionCardContained(fieldset);
    expect((await option.boundingBox())!.height).toBeGreaterThan(wideHeight);
  }
  await fieldset.evaluate((el) => {
    el.parentElement!.style.removeProperty("width");
  });
  await expectQuestionCardContained(fieldset);
  expect((await option.boundingBox())!.height).toBe(wideHeight);
});

test("short desktop options stay inline and match the input height", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const fieldset = page.locator("#question-card-compact fieldset");
  const boxes = await fieldset.locator("button, input").evaluateAll((nodes) =>
    nodes.map((node) => {
      const rect = node.getBoundingClientRect();
      return { y: rect.y, height: rect.height };
    }),
  );
  expect(boxes.length).toBe(4);
  for (const box of boxes) {
    expect(box.y).toBe(boxes[0].y);
    expect(box.height).toBe(boxes[0].height);
  }
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
  await expectQuestionCardContained(card.locator("fieldset"));
});
