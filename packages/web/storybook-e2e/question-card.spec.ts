import { expect, test } from "@playwright/test";
import { expectQuestionCardContained } from "../e2e/question-card-layout";

for (const width of [375, 1440]) {
  for (const locale of ["en", "zh-CN"]) {
    test(`question stories fit at ${width}px in ${locale}`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      for (const story of [
        "wide-compact-question",
        "narrow-question",
        "unbroken-labels",
        "wrapped-submission",
        "resolved-question",
      ]) {
        await page.goto(
          `/iframe.html?id=dev-chat-entries--${story}&viewMode=story&globals=locale:${locale}`,
        );
        // A resolved card folds to what it asked and how it ended; it opens
        // to the whole card, read-only.
        if (story === "resolved-question") {
          await page.locator("[data-chat-settled-card] button").click();
        }
        const card = page.locator("[data-widget-app]");
        await expect(card).toBeVisible();
        if (story === "wrapped-submission") {
          await expect(card.getByRole("button").first()).toBeDisabled();
          await expect(page.locator(".sb-errordisplay")).not.toBeVisible();
        }
        await page.evaluate(() => document.fonts.ready);
        await expectQuestionCardContained(card);
        expect(
          await page.evaluate(
            () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
          ),
        ).toBe(true);
      }
    });
  }
}
