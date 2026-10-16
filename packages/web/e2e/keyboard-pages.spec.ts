import { expect, type Page, test } from "@playwright/test";
import { installIosVisualViewport, setIosKeyboardTop } from "./ios-visual-viewport";

/**
 * With the iOS keyboard open on an iPad, a page that scrolls inside its own
 * frame ends at the keyboard's top edge, so its last rows and its editor stay
 * reachable instead of sitting behind the keyboard. The chat composer has its
 * own spec in keyboard-composer.spec.ts.
 *
 * An iPad is past the md breakpoint in both orientations, which is where these
 * pages size themselves to the screen rather than to the phone layout.
 */

const IPAD = { width: 820, height: 1180 };
const KEYBOARD_TOP = 780;

test.use({ viewport: IPAD, hasTouch: true, isMobile: true });

// `frame` selects the page's own frame: the element sized to the screen that
// holds its scroller.
const PAGES = [
  // The search field and the editor raise the keyboard here.
  { name: "the file browser", path: "/files", frame: 'main:has(input[data-slot="input"])' },
  // A top-level visit to the full-mode inventory, whose search field raises
  // the keyboard. As a workspace tile it runs in an iframe, which sizes it.
  {
    name: "the full-mode sessions inventory",
    path: "/full/apps/sessions/all",
    frame: "[data-safe-area-bounded]",
  },
];

async function openPage(page: Page, path: string, frame: string) {
  await page.goto(path);
  // A shared runner can render the route far slower than a warm local machine.
  await expect(page.locator(frame).last()).toBeVisible({ timeout: 30_000 });
}

async function measure(page: Page, frame: string) {
  return page.evaluate((selector) => {
    // The innermost match: the file browser's frame sits in the shell's own
    // <main>, which also contains the search field.
    const frames = document.querySelectorAll(selector);
    return {
      frameBottom: frames[frames.length - 1]!.getBoundingClientRect().bottom,
      documentHeight: document.body.scrollHeight,
    };
  }, frame);
}

for (const { name, path, frame } of PAGES) {
  test(`iOS Safari on an iPad: ${name} ends at the keyboard and returns when it closes`, async ({
    page,
  }) => {
    await installIosVisualViewport(page);
    await openPage(page, path, frame);
    const before = await measure(page, frame);
    expect(before.frameBottom).toBeCloseTo(IPAD.height, 0);

    await setIosKeyboardTop(page, KEYBOARD_TOP);
    await expect
      .poll(async () => (await measure(page, frame)).frameBottom)
      .toBeCloseTo(KEYBOARD_TOP, 0);
    // The layout viewport kept its full height, as on iOS, and the page did not:
    // nothing is left below the keyboard's top for iOS to pan to.
    expect((await measure(page, frame)).documentHeight).toBeLessThanOrEqual(KEYBOARD_TOP);

    await setIosKeyboardTop(page, null);
    await expect
      .poll(async () => (await measure(page, frame)).frameBottom)
      .toBeCloseTo(IPAD.height, 0);
  });
}
