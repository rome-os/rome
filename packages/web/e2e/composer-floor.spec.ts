import { expect, type Page, test } from "@playwright/test";
import { installIosVisualViewport, setIosKeyboardTop } from "./ios-visual-viewport";

/**
 * On a phone, the transcript does not show through the composer floor. A
 * reader scrolled up into history sees canvas beside and below the composer
 * box, not table rows, and a tap there does not land on a hidden link. From
 * the md breakpoint up the floor stays transparent, so messages scroll
 * visibly under the composer.
 */

// An iPhone's height with Safari's toolbars showing. The seeded table sits
// too high in the transcript to reach the composer of a taller screen.
const PHONE = { width: 390, height: 664 };
const DESKTOP = { width: 1280, height: 900 };
const HOME_INDICATOR_INSET = 34;
const KEYBOARD_TOP = 360;
// A seeded chat that overflows a phone screen and holds a markdown table.
const CHAT = "/chat/mock-chat-fitness-plan";
const COMPOSER = "[data-chat-composer-box]";
const FLOOR = "[data-chat-floor]";

async function openChat(page: Page) {
  await page.goto(CHAT);
  // A shared runner can render the route far slower than a warm local machine.
  await expect(page.locator(`${COMPOSER} textarea`)).toBeVisible({ timeout: 30_000 });
  await expect(page.locator("[data-timeline-anchor]").last()).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
}

/**
 * Scrolls the transcript up until its table straddles the composer box's
 * lower edge, so table rows fill the floor's bottom padding and side gutters.
 */
async function scrollTableUnderComposer(page: Page) {
  // How far the table's middle sits above the box's lower edge.
  const offset = await page.evaluate((composerSelector) => {
    const composer = document.querySelector(composerSelector)!.getBoundingClientRect();
    const table = document
      .querySelector("[data-timeline-anchor]")!
      .parentElement!.querySelector("table")!;
    const rect = table.getBoundingClientRect();
    return composer.bottom - (rect.top + rect.height / 2);
  }, COMPOSER);
  // A wheel gesture, not a scrollTop write: the transcript pins itself to the
  // live tail and only lets go when the reader scrolls.
  const viewport = page.viewportSize()!;
  await page.mouse.move(viewport.width / 2, viewport.height / 3);
  await page.mouse.wheel(0, -offset);
  await expect.poll(async () => (await measureFloor(page)).tableUnderGap).toBe(true);
}

async function measureFloor(page: Page) {
  return page.evaluate(
    ({ composerSelector, floorSelector }) => {
      const floor = document.querySelector(floorSelector)!;
      const box = document.querySelector(composerSelector)!.getBoundingClientRect();
      const table = floor.parentElement!.querySelector("table")!.getBoundingClientRect();
      const viewportBottom = window.visualViewport?.height ?? window.innerHeight;
      const canvas = getComputedStyle(
        floor.parentElement!.closest('[class~="bg-chat-canvas"]')!,
      ).backgroundColor;
      // What a tap would land on, sampled in the gap below the box and in the
      // gutter beside it.
      const below = { x: (box.left + box.right) / 2, y: (box.bottom + viewportBottom) / 2 };
      const beside = { x: box.left / 2, y: (box.top + box.bottom) / 2 };
      const hitsFloor = ({ x, y }: { x: number; y: number }) =>
        floor.contains(document.elementFromPoint(x, y));
      return {
        floorBackground: getComputedStyle(floor).backgroundColor,
        canvas,
        tableUnderGap: table.top < box.bottom && table.bottom > below.y,
        gapHeight: viewportBottom - box.bottom,
        gutterWidth: box.left,
        belowHitsFloor: hitsFloor(below),
        besideHitsFloor: hitsFloor(beside),
      };
    },
    { composerSelector: COMPOSER, floorSelector: FLOOR },
  );
}

function expectOpaqueFloor(geometry: Awaited<ReturnType<typeof measureFloor>>) {
  expect(geometry.gapHeight).toBeGreaterThan(0);
  expect(geometry.gutterWidth).toBeGreaterThan(0);
  expect(geometry.floorBackground).toBe(geometry.canvas);
  expect(geometry.belowHitsFloor).toBe(true);
  expect(geometry.besideHitsFloor).toBe(true);
}

test.describe("on a phone", () => {
  test.use({ viewport: PHONE, hasTouch: true, isMobile: true });

  test("history scrolled under the composer stays hidden above the home indicator", async ({
    page,
  }) => {
    await openChat(page);
    // env(safe-area-inset-bottom) is zero in desktop Chromium. The stylesheet
    // reads it through this property so a spec can stand in a real iPhone's.
    await page.locator("html").evaluate((element, inset) => {
      (element as HTMLElement).style.setProperty("--rome-safe-area-inset-bottom", `${inset}px`);
    }, HOME_INDICATOR_INSET);
    await scrollTableUnderComposer(page);

    const geometry = await measureFloor(page);
    // The floor's padding covers the home indicator and 1rem more.
    expect(geometry.gapHeight).toBeGreaterThanOrEqual(HOME_INDICATOR_INSET + 16);
    expectOpaqueFloor(geometry);
  });

  test("history scrolled under the composer stays hidden with the iOS keyboard open", async ({
    page,
  }) => {
    // The keyboard zeroes the safe-area inset, but the floor keeps its 1rem.
    await installIosVisualViewport(page);
    await openChat(page);
    await setIosKeyboardTop(page, KEYBOARD_TOP);
    await expect
      .poll(async () =>
        page.locator(COMPOSER).evaluate((box) => box.getBoundingClientRect().bottom),
      )
      .toBeLessThan(KEYBOARD_TOP);
    await scrollTableUnderComposer(page);

    expectOpaqueFloor(await measureFloor(page));
  });
});

test.describe("on a desktop", () => {
  test.use({ viewport: DESKTOP });

  test("the floor stays transparent, so messages scroll under the composer", async ({ page }) => {
    await openChat(page);

    const floor = page.locator(FLOOR);
    await expect(floor).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
    await expect(floor).toHaveCSS("pointer-events", "none");
  });
});
