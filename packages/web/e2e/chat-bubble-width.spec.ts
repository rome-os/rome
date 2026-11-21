import { expect, type Page, test } from "@playwright/test";

// A chat bubble is at most the reading width and at most its column. Wide
// content, such as a table, scrolls inside the bubble instead of pushing it
// past the column. Both chats carry the mock trip plan's four-column table.
const CHATS = [
  { path: "/message", ready: "Nothing needs you before" },
  { path: "/chat/mock-chat-long-answers", ready: "Any time." },
];

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("i18nextLng", "en"));
});

async function open(page: Page, path: string, ready: string) {
  await page.goto(path);
  await expect(page.getByText(ready).first()).toBeVisible({ timeout: 30_000 });
  await page.evaluate(() => document.fonts.ready);
}

// Each bubble's overflow past the box that holds it, in px.
function bubbleOverflow(page: Page) {
  return page.locator("[data-chat-bubble]").evaluateAll((bubbles) =>
    bubbles.map((bubble) => {
      const own = bubble.getBoundingClientRect();
      const column = bubble.parentElement!.getBoundingClientRect();
      return Math.max(0, own.right - column.right, column.left - own.left);
    }),
  );
}

for (const width of [320, 390]) {
  for (const { path, ready } of CHATS) {
    test(`bubbles stay inside their column at ${width}px in ${path}`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await open(page, path, ready);

      for (const overflow of await bubbleOverflow(page)) expect(overflow).toBeLessThan(1);
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
        ),
      ).toBe(true);
      // The table is wider than the bubble, so it scrolls inside it.
      const scroller = page.locator('[data-streamdown="table-wrapper"] > :has(> table)').first();
      expect(await scroller.evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(true);
    });
  }
}

test("a bubble stops at the reading width in a wide column", async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 900 });
  await open(page, "/chat/mock-chat-long-answers", "Any time.");

  const widths = await page
    .locator("[data-chat-bubble]")
    .evaluateAll((bubbles) => bubbles.map((bubble) => bubble.getBoundingClientRect().width));
  // 42rem, the kit's reading width.
  for (const bubbleWidth of widths) expect(bubbleWidth).toBeLessThanOrEqual(672.5);
  expect(Math.max(...widths)).toBeGreaterThan(600);
});
