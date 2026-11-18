import { expect, test } from "@playwright/test";

test.use({ viewport: { width: 1280, height: 900 } });

for (const chat of [
  { name: "common chat", path: "/chat/mock-chat-fitness-plan" },
  { name: "assistant chat", path: "/assistants" },
  { name: "Concierge chat", path: "/message" },
]) {
  test(`${chat.name}: top blur stays inside the reserved header area`, async ({ page }) => {
    await page.goto(chat.path);
    await expect(page.locator("[data-chat-composer-box] textarea")).toBeVisible({
      timeout: 30_000,
    });
    const blur = page.locator("[data-slot=progressive-blur]").first();
    await expect(blur).toBeVisible();
    const clearTop = await page.locator("[data-chat-floor]").evaluate((floor) => {
      const scroller = floor.parentElement!;
      return (
        scroller.getBoundingClientRect().top +
        Number.parseFloat(getComputedStyle(scroller).scrollPaddingTop)
      );
    });
    const bounds = (await blur.boundingBox())!;
    expect(bounds.y + bounds.height).toBeLessThanOrEqual(clearTop + 1);
  });

  if (chat.name === "Concierge chat") continue;

  test(`${chat.name}: the header leaves the scrollbar track reachable`, async ({ page }) => {
    await page.goto(chat.path);
    await expect(page.locator("[data-chat-composer-box] textarea")).toBeVisible({
      timeout: 30_000,
    });
    // A styled scrollbar reserves a classic gutter even on macOS Chromium.
    await page.addStyleTag({
      content:
        "* { scrollbar-width: auto !important; scrollbar-color: auto !important; scrollbar-gutter: stable; } ::-webkit-scrollbar { width: 16px; }",
    });
    const header = page.locator("[data-slot=progressive-blur]").first().locator("xpath=..");
    const headerBounds = (await header.boundingBox())!;
    const hit = await page.locator("[data-chat-floor]").evaluate(
      (floor, y) => {
        const scroller = floor.parentElement!;
        const bounds = scroller.getBoundingClientRect();
        return {
          gutter: scroller.offsetWidth - scroller.clientWidth,
          hitsScroller: document.elementFromPoint(bounds.right - 4, y) === scroller,
        };
      },
      headerBounds.y + headerBounds.height / 2,
    );
    expect(hit.gutter).toBe(16);
    expect(hit.hitsScroller).toBe(true);
    await header.getByRole("button").first().click();
    await expect(page.getByRole("menu")).toBeVisible();
  });
}
