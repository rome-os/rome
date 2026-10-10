import { expect, type Page, test } from "@playwright/test";

/**
 * The composer picks its row layout from its own width. A wide composer keeps
 * Send at the end of the toolbar row. A narrow one puts Send beside the input
 * and gives the toolbar a whole row that scrolls sideways instead of wrapping.
 * jsdom lays out nothing and resolves no container query, so only a real
 * browser can tell which layout rendered.
 *
 * The mock's toolbar fits a 320px phone, which leaves the scroll path idle. The
 * overflow case widens the first toolbar control to drive it.
 */

const BOX = "[data-chat-composer-box]";
const TOOLBAR = "[data-chat-composer-toolbar]";

type Rect = { top: number; bottom: number; left: number; right: number; center: number };

async function measure(page: Page) {
  return page.locator(BOX).evaluate((box, toolbarSelector) => {
    const rect = (node: Element): Rect => {
      const r = node.getBoundingClientRect();
      return {
        top: r.top,
        bottom: r.bottom,
        left: r.left,
        right: r.right,
        center: r.top + r.height / 2,
      };
    };
    const toolbar = box.querySelector(toolbarSelector)!;
    const send = box.querySelector('button[aria-label="Send"]')!;
    return {
      box: rect(box),
      textarea: rect(box.querySelector("textarea")!),
      toolbar: rect(toolbar),
      send: rect(send),
      controls: [...toolbar.querySelectorAll("button")]
        .filter((button) => button !== send && button.getClientRects().length > 0)
        .map(rect),
    };
  }, TOOLBAR);
}

async function openComposer(page: Page) {
  await page.addInitScript(() => localStorage.setItem("i18nextLng", "en"));
  await page.goto("/chat");
  // A cold rsbuild dev server compiles the route's chunk on demand.
  await expect(page.locator(`${BOX} textarea`)).toBeVisible({ timeout: 30_000 });
  await page.evaluate(() => document.fonts.ready);
}

// Rects come back fractional, so rows compare to the nearest pixel.
const sameRow = (a: Rect, b: Rect) => Math.abs(a.center - b.center) < 1;

for (const { width, height } of [
  { width: 320, height: 800 },
  { width: 390, height: 844 },
  { width: 440, height: 956 },
]) {
  test.describe(`${width}px touch`, () => {
    test.use({ viewport: { width, height }, hasTouch: true });

    test("Send sits beside the input and the toolbar keeps one row", async ({ page }) => {
      await openComposer(page);
      const g = await measure(page);

      expect(g.send.bottom, "Send sits above the toolbar row").toBeLessThanOrEqual(g.toolbar.top);
      expect(g.textarea.right, "the input ends before Send").toBeLessThanOrEqual(g.send.left);
      expect(g.send.right).toBeLessThanOrEqual(g.box.right);
      for (const control of g.controls) expect(sameRow(control, g.controls[0]!)).toBe(true);
    });

    test("an overflowing toolbar scrolls instead of wrapping", async ({ page }) => {
      await openComposer(page);
      const toolbar = page.locator(TOOLBAR);
      // Widen a control the composer rendered rather than appending one, so
      // the rail's size observer sees the change as a longer label would.
      await toolbar.evaluate((node) => {
        (node.firstElementChild as HTMLElement).style.minWidth = "480px";
      });

      await expect(toolbar).toHaveAttribute("data-scroll-right", "true");
      const g = await measure(page);
      for (const control of g.controls) expect(sameRow(control, g.controls[0]!)).toBe(true);
      expect(g.toolbar.left).toBeGreaterThanOrEqual(g.box.left);
      expect(g.toolbar.right).toBeLessThanOrEqual(g.box.right);

      await toolbar.evaluate((node) => {
        node.scrollLeft = node.scrollWidth;
      });
      await expect(toolbar).toHaveAttribute("data-scroll-left", "true");
      await expect(toolbar).toHaveAttribute("data-scroll-right", "false");
    });
  });
}

for (const { width, height, hasTouch } of [
  { width: 820, height: 1180, hasTouch: true },
  { width: 1280, height: 900, hasTouch: false },
]) {
  test.describe(`${width}px ${hasTouch ? "touch" : "pointer"}`, () => {
    test.use({ viewport: { width, height }, hasTouch });

    test("Send ends the toolbar row below the input", async ({ page }) => {
      await openComposer(page);
      const g = await measure(page);

      expect(g.send.top, "Send sits below the input").toBeGreaterThanOrEqual(g.textarea.bottom);
      for (const control of g.controls) expect(sameRow(control, g.send)).toBe(true);
      expect(g.send.left).toBeGreaterThanOrEqual(Math.max(...g.controls.map((c) => c.right)));
    });
  });
}
