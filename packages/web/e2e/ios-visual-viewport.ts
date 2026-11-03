import type { Page } from "@playwright/test";

/**
 * Stands in for iOS Safari's on-screen keyboard. iOS keeps the layout viewport
 * at full height when the keyboard opens and shrinks only
 * `window.visualViewport`, so this swaps in a visual viewport whose height the
 * spec controls through {@link setIosKeyboardTop}. Installed before the bundle
 * runs, so the dashboard tracks this viewport.
 */
export function installIosVisualViewport(page: Page) {
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

/** Opens the keyboard so its top edge sits at `top`, or closes it with null. */
export function setIosKeyboardTop(page: Page, top: number | null) {
  return page.evaluate((keyboardTop) => {
    (window as unknown as { setKeyboardTop: (top: number | null) => void }).setKeyboardTop(
      keyboardTop,
    );
  }, top);
}
