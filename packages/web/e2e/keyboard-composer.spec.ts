import { expect, type Page, test } from "@playwright/test";

/**
 * With the on-screen keyboard open, the chat composer sits fully above it, the
 * newest message stays in view above the composer, and the composer returns to
 * the bottom of the screen once the keyboard closes.
 *
 * Desktop Chromium has no on-screen keyboard, so each spec reproduces what a
 * phone does to the page when one opens:
 * - The Rome app on Android shrinks the WebView to end at the keyboard, which
 *   is an ordinary viewport resize.
 * - iOS, in Safari and in the app's WKWebView, keeps the layout viewport at
 *   full height and shrinks only `window.visualViewport`. The spec swaps in a
 *   visual viewport whose height it controls.
 */

const PHONE = { width: 390, height: 844 };
const KEYBOARD_TOP = 512;
// A seeded chat whose transcript overflows a phone screen.
const CHAT = "/chat/mock-chat-fitness-plan";
const COMPOSER = "[data-chat-composer-box]";

test.use({ viewport: PHONE, hasTouch: true, isMobile: true });

async function openChat(page: Page) {
  await page.goto(CHAT);
  // A cold rsbuild dev server compiles the route's chunk on demand.
  await expect(page.locator(`${COMPOSER} textarea`)).toBeVisible({ timeout: 30_000 });
  await expect(page.locator("[data-timeline-anchor]").last()).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
}

async function measure(page: Page) {
  return page.evaluate((composerSelector) => {
    const composer = document.querySelector(composerSelector)!.getBoundingClientRect();
    const header = document.querySelector('header[data-app-titlebar="header"]')!;
    // Timeline anchors wrap only the person's turns. Their parent is the
    // transcript, whose last child is the newest row whoever wrote it.
    const transcript = document.querySelector("[data-timeline-anchor]")!.parentElement!;
    const newest = transcript.lastElementChild!.getBoundingClientRect();
    const scroller = transcript.closest(".overflow-y-auto")!;
    return {
      composerTop: composer.top,
      composerBottom: composer.bottom,
      headerTop: header.getBoundingClientRect().top,
      newestBottom: newest.bottom,
      transcriptOverflows: scroller.scrollHeight > scroller.clientHeight,
    };
  }, COMPOSER);
}

function expectComposerAboveKeyboard(geometry: Awaited<ReturnType<typeof measure>>) {
  expect(geometry.transcriptOverflows).toBe(true);
  expect(geometry.headerTop).toBeCloseTo(0, 0);
  expect(geometry.composerBottom).toBeLessThanOrEqual(KEYBOARD_TOP);
  // Directly above it: the gap is the composer floor's own 1rem padding.
  expect(KEYBOARD_TOP - geometry.composerBottom).toBeLessThanOrEqual(24);
  expect(geometry.composerTop).toBeGreaterThan(geometry.headerTop);
  // The newest message ends in the strip between the header and the composer.
  expect(geometry.newestBottom).toBeLessThanOrEqual(geometry.composerTop + 1);
  expect(geometry.newestBottom).toBeGreaterThan(geometry.headerTop + 48);
}

test("Android app: the WebView shrinking to the keyboard keeps the composer and newest message in view", async ({
  page,
}) => {
  await openChat(page);
  const before = await measure(page);

  await page.setViewportSize({ width: PHONE.width, height: KEYBOARD_TOP });
  await expect.poll(async () => (await measure(page)).composerBottom).toBeLessThan(KEYBOARD_TOP);
  expectComposerAboveKeyboard(await measure(page));

  await page.setViewportSize(PHONE);
  await expect
    .poll(async () => (await measure(page)).composerBottom)
    .toBeCloseTo(before.composerBottom, 0);
});

test("iOS: a visual viewport shrunk by the keyboard keeps the composer and newest message in view", async ({
  page,
}) => {
  // Installed before the bundle runs, so the dashboard tracks this viewport.
  await page.addInitScript(() => {
    // Reads the layout viewport live: at document start it is still the 980px
    // default page, before the viewport tag narrows it to the phone.
    let keyboardTop: number | null = null;
    const fake = new EventTarget();
    Object.defineProperties(fake, {
      height: { get: () => keyboardTop ?? window.innerHeight },
      width: { get: () => window.innerWidth },
      pageTop: { get: () => window.scrollY },
      pageLeft: { get: () => window.scrollX },
      offsetTop: { value: 0 },
      offsetLeft: { value: 0 },
      scale: { value: 1 },
    });
    window.addEventListener("resize", () => fake.dispatchEvent(new Event("resize")));
    Object.defineProperty(window, "visualViewport", { configurable: true, value: fake });
    (window as unknown as { setKeyboardTop: (top: number | null) => void }).setKeyboardTop = (
      top,
    ) => {
      keyboardTop = top;
      fake.dispatchEvent(new Event("resize"));
    };
  });
  await openChat(page);
  const before = await measure(page);

  await page.evaluate((top) => {
    (window as unknown as { setKeyboardTop: (top: number) => void }).setKeyboardTop(top);
  }, KEYBOARD_TOP);
  await expect.poll(async () => (await measure(page)).composerBottom).toBeLessThan(KEYBOARD_TOP);
  expectComposerAboveKeyboard(await measure(page));
  // The layout viewport kept its full height, as on iOS, and the page did not:
  // nothing is left below the composer for iOS to pan to.
  expect(await page.evaluate(() => document.body.scrollHeight)).toBeLessThanOrEqual(KEYBOARD_TOP);

  await page.evaluate(() => {
    (window as unknown as { setKeyboardTop: (top: null) => void }).setKeyboardTop(null);
  });
  await expect
    .poll(async () => (await measure(page)).composerBottom)
    .toBeCloseTo(before.composerBottom, 0);
});

test("tapping into the composer cannot zoom the page", async ({ page }) => {
  await openChat(page);
  // iOS zooms into a focused field whose text is under 16px unless the page
  // caps its scale at 1, and this cap is also what forbids pinch-zoom.
  const viewport = await page.locator('meta[name="viewport"]').getAttribute("content");
  expect(viewport).toContain("maximum-scale=1.0");
  expect(viewport).toContain("user-scalable=no");
});
