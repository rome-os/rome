import { expect, type Page, test } from "@playwright/test";

/**
 * With the on-screen keyboard open, the chat composer sits fully above it, the
 * newest message stays in view above the composer, and the composer returns to
 * the bottom of the screen once the keyboard closes.
 *
 * Desktop Chromium has no on-screen keyboard, so each spec reproduces what a
 * phone browser does to the page when one opens:
 * - Chrome on Android, told `interactive-widget=resizes-content` by the
 *   viewport tag, shrinks the page to end at the keyboard, which is an
 *   ordinary viewport resize.
 * - iOS Safari keeps the layout viewport at full height and shrinks only
 *   `window.visualViewport`. The spec swaps in a visual viewport whose height
 *   it controls.
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
    // The phone header; from the md breakpoint up the sidebar replaces it and
    // the chat starts at the top of the screen.
    const header = document.querySelector('header[data-app-titlebar="header"]')!;
    const headerRect = header.getBoundingClientRect();
    const headerShown = getComputedStyle(header).display !== "none";
    // Timeline anchors wrap only the person's turns. Their parent is the
    // transcript, whose last child is the newest row whoever wrote it.
    const transcript = document.querySelector("[data-timeline-anchor]")!.parentElement!;
    const newest = transcript.lastElementChild!.getBoundingClientRect();
    const scroller = transcript.closest(".overflow-y-auto")!;
    return {
      composerTop: composer.top,
      composerBottom: composer.bottom,
      headerTop: headerShown ? headerRect.top : 0,
      contentTop: headerShown ? headerRect.bottom : 0,
      newestBottom: newest.bottom,
      transcriptOverflows: scroller.scrollHeight > scroller.clientHeight,
    };
  }, COMPOSER);
}

function expectComposerAboveKeyboard(
  geometry: Awaited<ReturnType<typeof measure>>,
  keyboardTop = KEYBOARD_TOP,
) {
  expect(geometry.transcriptOverflows).toBe(true);
  expect(geometry.headerTop).toBeCloseTo(0, 0);
  expect(geometry.composerBottom).toBeLessThanOrEqual(keyboardTop);
  // Directly above it: the gap is the composer floor's own 1rem padding.
  expect(keyboardTop - geometry.composerBottom).toBeLessThanOrEqual(24);
  expect(geometry.composerTop).toBeGreaterThan(geometry.contentTop);
  // The newest message ends in the strip between the header and the composer.
  expect(geometry.newestBottom).toBeLessThanOrEqual(geometry.composerTop + 1);
  expect(geometry.newestBottom).toBeGreaterThan(geometry.contentTop);
}

test("Android Chrome: the page shrinking to the keyboard keeps the composer and newest message in view", async ({
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

// Installed before the bundle runs, so the dashboard tracks this viewport.
function installIosVisualViewport(page: Page) {
  return page.addInitScript(() => {
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
}

async function expectIosKeyboardRoundTrip(
  page: Page,
  keyboardTop: number,
  { homeIndicatorInset = 0 } = {},
) {
  await openChat(page);
  // env(safe-area-inset-bottom) is zero in desktop Chromium. The stylesheet
  // reads it through this property so a spec can stand in a real iPhone's.
  await page.locator("html").evaluate((element, inset) => {
    (element as HTMLElement).style.setProperty("--rome-safe-area-inset-bottom", `${inset}px`);
  }, homeIndicatorInset);
  const before = await measure(page);
  // With the keyboard closed, the composer clears the home indicator.
  expect(page.viewportSize()!.height - before.composerBottom).toBeGreaterThanOrEqual(
    homeIndicatorInset + 16,
  );

  await page.evaluate((top) => {
    (window as unknown as { setKeyboardTop: (top: number) => void }).setKeyboardTop(top);
  }, keyboardTop);
  await expect.poll(async () => (await measure(page)).composerBottom).toBeLessThan(keyboardTop);
  expectComposerAboveKeyboard(await measure(page), keyboardTop);
  // The layout viewport kept its full height, as on iOS, and the page did not:
  // nothing is left below the composer for iOS to pan to.
  expect(await page.evaluate(() => document.body.scrollHeight)).toBeLessThanOrEqual(keyboardTop);

  await page.evaluate(() => {
    (window as unknown as { setKeyboardTop: (top: null) => void }).setKeyboardTop(null);
  });
  await expect
    .poll(async () => (await measure(page)).composerBottom)
    .toBeCloseTo(before.composerBottom, 0);
}

test("iOS Safari: a visual viewport shrunk by the keyboard keeps the composer and newest message in view", async ({
  page,
}) => {
  await installIosVisualViewport(page);
  await expectIosKeyboardRoundTrip(page, KEYBOARD_TOP);
});

test("iOS Safari on a Face ID iPhone: the home indicator's inset gives way to the keyboard", async ({
  page,
}) => {
  // The keyboard covers the home indicator, so its 34px inset would otherwise
  // sit as an empty band between the composer and the keyboard.
  await installIosVisualViewport(page);
  await expectIosKeyboardRoundTrip(page, KEYBOARD_TOP, { homeIndicatorInset: 34 });
});

test.describe("on a landscape phone, past the md breakpoint", () => {
  // An iPhone on its side is 844px wide, so it gets the desktop layout with the
  // sidebar in flow. iPads get the same layout in both orientations.
  test.use({ viewport: { width: 844, height: 390 } });

  test("iOS Safari: the keyboard leaves the composer and newest message in view", async ({
    page,
  }) => {
    await installIosVisualViewport(page);
    await expectIosKeyboardRoundTrip(page, 220);
  });
});

test("the viewport tag forbids zoom and asks Android to resize the page for the keyboard", async ({
  page,
}) => {
  await openChat(page);
  const content = await page.locator('meta[name="viewport"]').getAttribute("content");
  const keys = Object.fromEntries(
    (content ?? "").split(",").map((pair) => pair.trim().split("=") as [string, string]),
  );
  // iOS zooms into a focused field whose text is under 16px unless the page
  // caps its scale at 1, and this cap is also what forbids pinch-zoom.
  expect(keys["maximum-scale"]).toBe("1.0");
  expect(keys["user-scalable"]).toBe("no");
  // Without it Chrome on Android slides the keyboard over the page, as iOS
  // does, instead of resizing the page as the Android spec above reproduces.
  expect(keys["interactive-widget"]).toBe("resizes-content");
});
