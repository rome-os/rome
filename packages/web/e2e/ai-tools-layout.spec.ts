import { expect, test } from "@playwright/test";

/**
 * A provider row puts its name and status beside its sign-in buttons. On a
 * phone the large control scale makes those buttons wide enough that both no
 * longer fit, and the row has to move the buttons to their own line rather
 * than squeeze the status into two lines or slide the name under a button.
 * Only a real layout engine can tell which of those happened.
 */
for (const width of [320, 390]) {
  test.describe(`AI Tools rows on a ${width}px phone`, () => {
    test.use({ viewport: { width, height: 844 }, isMobile: true, hasTouch: true });

    test("keep each status on one line and clear of the buttons", async ({ page }) => {
      await page.addInitScript(() => localStorage.setItem("i18nextLng", "en"));
      await page.goto("/settings/ai-tools");

      // The squeeze only exists at the large scale. Without it this test
      // would pass on any layout.
      await expect(page.locator('[data-ui-scale="large"]').first()).toBeAttached();

      const statuses = [
        page.getByText("Not connected", { exact: true }),
        page.getByText("Connected", { exact: true }),
      ];
      for (const status of statuses) await expect(status).toBeVisible();
      await page.evaluate(() => document.fonts.ready);

      for (const status of statuses) {
        const lines = await status.evaluate(
          (el) => el.getBoundingClientRect().height / parseFloat(getComputedStyle(el).lineHeight),
        );
        expect(lines).toBeLessThan(1.5);
      }

      const labels = [
        page.getByText("ChatGPT", { exact: true }),
        page.getByText("Claude", { exact: true }),
        ...statuses,
      ];
      const buttons = ["Browser", "Device code", "API Key", "Log Out"].map((name) =>
        page.getByRole("button", { name, exact: true }),
      );
      for (const label of labels) {
        const a = (await label.boundingBox())!;
        for (const button of buttons) {
          const b = (await button.boundingBox())!;
          const overlaps =
            a.x < b.x + b.width &&
            b.x < a.x + a.width &&
            a.y < b.y + b.height &&
            b.y < a.y + a.height;
          expect(
            overlaps,
            `${await label.textContent()} overlaps ${await button.textContent()}`,
          ).toBe(false);
        }
      }
    });
  });
}
