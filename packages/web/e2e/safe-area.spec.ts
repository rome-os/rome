import { expect, test } from "@playwright/test";

const TOP_INSET = 47;
const BOTTOM_INSET = 34;

test.use({ viewport: { width: 390, height: 844 } });

test("mobile shell paints edge-to-edge while scroll content respects safe areas", async ({
  page,
}) => {
  await page.goto("/sessions");
  await expect(page.locator("header[data-mobile-header]")).toBeVisible({
    timeout: 30_000,
  });

  // env(safe-area-inset-*) is zero in desktop Chromium. Rome's indirection
  // makes the exact iPhone geometry overrideable so this regression is tested
  // with a real top and bottom inset instead of class-name assertions alone.
  await page.locator("html").evaluate(
    (element, insets) => {
      const root = element as HTMLElement;
      root.style.setProperty("--rome-safe-area-top", `${insets.top}px`);
      root.style.setProperty("--rome-safe-area-bottom", `${insets.bottom}px`);
    },
    { top: TOP_INSET, bottom: BOTTOM_INSET },
  );

  const header = page.locator("header[data-mobile-header]");
  const content = page.locator("[data-safe-area-bounded]");
  const scrollArea = page.locator("[data-safe-area-scroll]");
  const [headerBox, contentBox, scrollPaddingBottom] = await Promise.all([
    header.boundingBox(),
    content.boundingBox(),
    scrollArea.evaluate((element) => getComputedStyle(element).paddingBottom),
  ]);

  expect(headerBox).not.toBeNull();
  expect(contentBox).not.toBeNull();
  expect(headerBox!.height).toBeCloseTo(48 + TOP_INSET, 0);
  expect(contentBox!.y).toBeGreaterThanOrEqual(TOP_INSET);
  expect(contentBox!.y + contentBox!.height).toBeCloseTo(844, 0);
  expect(Number.parseFloat(scrollPaddingBottom)).toBeCloseTo(BOTTOM_INSET, 0);
});
