import { devices, expect, test } from "@playwright/test";

/**
 * `.touch-target` (in `@rome-os/ui/styles.css`) raises a control to the 44px
 * touch floor where the device has no pointer. Its behavior is decided
 * entirely by the cascade — which half sits in `@layer base` and which is
 * unlayered — so nothing short of a real browser can check it: jsdom resolves
 * neither layers nor layout, and the class strings are identical either way.
 *
 * The competing utilities are injected rather than written as Tailwind
 * classes. Tailwind only compiles what it finds in scanned source, so a class
 * this page happens not to use is absent from the CSS entirely — the probe
 * then measures an unstyled element and the case passes for the wrong reason.
 * Each stand-in is declared in `@layer utilities`, which is where Tailwind
 * emits the real ones, so the layering under test is the real layering.
 *
 * Every case measures a baseline without `.touch-target` first. That is what
 * separates "the contract broke" from "the fixture is dead".
 */
test.use({ ...devices["Pixel 5"] });

const STAND_INS = `@layer utilities {
  .probe-below { width: 24px; height: 24px }
  .probe-above { width: 56px; height: 56px }
  .probe-wide { width: 160px }
  .probe-hidden { display: none }
  .probe-aligned { display: flex; align-items: flex-start }
  .probe-min-w-0 { min-width: 0 }
  @media (max-width: 639px) { .probe-responsively-hidden { display: none } }
}`;

test("the touch floor raises small controls without overruling the caller", async ({ page }) => {
  await page.goto("/");

  // Every assertion below is conditioned on a pointerless device. If emulation
  // ever stops producing one, they would all pass vacuously.
  expect(await page.evaluate(() => matchMedia("(hover: none)").matches)).toBe(true);

  // Poll the plainest case until the kit stylesheet is live rather than
  // measuring a page that has no CSS yet.
  await expect
    .poll(
      async () =>
        page.evaluate(() => {
          const probe = document.createElement("button");
          probe.className = "touch-target";
          document.body.append(probe);
          const { width } = probe.getBoundingClientRect();
          probe.remove();
          return width;
        }),
      { timeout: 30_000 },
    )
    .toBe(44);

  const measured = await page.evaluate((standIns) => {
    const sheet = document.createElement("style");
    sheet.textContent = standIns;
    document.head.append(sheet);

    const read = (tag: string, className: string) => {
      const probe = document.createElement(tag);
      probe.className = className;
      document.body.append(probe);
      const { display, alignItems } = getComputedStyle(probe);
      const { width, height } = probe.getBoundingClientRect();
      probe.remove();
      return { width, height, display, alignItems };
    };
    // Each case as the caller would write it, with and without the utility.
    const both = (tag: string, className: string) => ({
      without: read(tag, className),
      with: read(tag, `${className} touch-target`),
    });

    const seen = {
      belowFloor: both("button", "probe-below"),
      aboveFloor: both("button", "probe-above"),
      inlineElement: both("span", ""),
      hidden: both("button", "probe-hidden"),
      responsivelyHidden: both("button", "probe-responsively-hidden"),
      callerAligned: both("button", "probe-below probe-aligned"),
      minWidthZero: both("button", "probe-below probe-min-w-0"),
      wideContent: both("button", "probe-wide"),
    };

    sheet.remove();
    return seen;
  }, STAND_INS);

  // The stand-ins are live — otherwise every case below measures nothing.
  expect(measured.belowFloor.without).toMatchObject({ width: 24, height: 24 });
  expect(measured.aboveFloor.without).toMatchObject({ width: 56, height: 56 });
  expect(measured.hidden.without.display).toBe("none");
  expect(measured.responsivelyHidden.without.display).toBe("none");
  expect(measured.wideContent.without.width).toBe(160);

  // Raises a control that is under the floor.
  expect(measured.belowFloor.with).toMatchObject({ width: 44, height: 44 });
  // A floor, not a fixed size — 56px stays 56px.
  expect(measured.aboveFloor.with).toMatchObject({ width: 56, height: 56 });
  // `min-*` does not apply to a non-replaced inline element, so the floor
  // depends on the utility supplying a display of its own.
  expect(measured.inlineElement.with).toMatchObject({ width: 44, height: 44 });

  // A caller who hid the control means it. This is the regression the
  // `@layer base` placement exists to prevent.
  expect(measured.hidden.with.display).toBe("none");
  expect(measured.responsivelyHidden.with.display).toBe("none");

  // A caller who set display and alignment wins both, and still gets the
  // floor — the two halves are independent.
  expect(measured.callerAligned.with).toMatchObject({
    display: "flex",
    alignItems: "flex-start",
    width: 44,
    height: 44,
  });

  // Why the floor stays unlayered: a `min-w-*` utility would otherwise
  // outrank it and remove the guarantee entirely.
  expect(measured.minWidthZero.with.width).toBe(44);

  // One axis at a time, so wide content grows past the floor instead of
  // being squared off.
  expect(measured.wideContent.with).toMatchObject({ width: 160, height: 44 });
});
