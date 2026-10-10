import { expect, test } from "@playwright/test";

/**
 * The chat composer's empty height is one `text-composer` line box, and the box's
 * own padding is the only inset around it — so the space above the first line
 * of typed text equals the space below the toolbar row.
 *
 * The floor that holds this is declared as `min-height: 1lh`, which resolves
 * against the role rather than restating its px. jsdom applies no `min-height`
 * and lays out no text, so the unit tests can only pin that the declaration is
 * in line-box units and that the resize handler writes no floor of its own.
 * Whether `1lh` actually derives the role's line box, and whether the two
 * insets come out equal, is visible only here. A retune of Composer that breaks
 * either fails in this spec and nowhere else.
 */

const BOX = "[data-chat-composer-box]";
// The row the box ends on. Named rather than taken positionally: the box also
// holds an error alert, a disabled hint, and the pending-upload list, so "the
// last child" would quietly become one of those and measure the wrong gap.
const TOOLBAR = "[data-chat-composer-toolbar]";

test("the empty composer is one composer line box, inset only by the box's padding", async ({
  page,
}) => {
  await page.goto("/chat");
  // A cold rsbuild dev server compiles the route's chunk on demand.
  await expect(page.locator(`${BOX} textarea`)).toBeVisible({ timeout: 30_000 });
  await page.evaluate(() => document.fonts.ready);

  const geometry = await page.evaluate(
    ({ boxSelector, toolbarSelector }) => {
      const box = document.querySelector(boxSelector);
      const textarea = box?.querySelector("textarea");
      const toolbar = box?.querySelector(toolbarSelector);
      if (!box || !textarea || !toolbar) return null;

      const boxStyle = getComputedStyle(box);
      const textareaStyle = getComputedStyle(textarea);
      const boxRect = box.getBoundingClientRect();
      const textareaRect = textarea.getBoundingClientRect();
      const toolbarRect = toolbar.getBoundingClientRect();

      // The insets describe the box's padding only while the textarea is the
      // first thing in the box and the toolbar the last. The box also holds an
      // error alert, a disabled hint, and the pending-upload list — one of those
      // rendering measures a different gap, so report it as its own failure
      // rather than letting it read as a padding regression.
      const laidOut = [...box.querySelectorAll("*")].filter(
        (node) => node.getBoundingClientRect().height > 0,
      );
      const describe = (node: Element) =>
        typeof node.className === "string" && node.className ? node.className : node.tagName;

      return {
        lineBox: Number.parseFloat(textareaStyle.lineHeight),
        // `1lh` reaches computed style already resolved to px.
        declaredFloor: Number.parseFloat(textareaStyle.minHeight),
        textareaHeight: textareaRect.height,
        topInset: textareaRect.top - boxRect.top,
        bottomInset: boxRect.bottom - toolbarRect.bottom,
        declaredInset:
          Number.parseFloat(boxStyle.paddingTop) + Number.parseFloat(boxStyle.borderTopWidth),
        above: laidOut
          .filter(
            (node) =>
              !node.contains(textarea) && node.getBoundingClientRect().top < textareaRect.top,
          )
          .map(describe),
        below: laidOut
          .filter(
            (node) =>
              !node.contains(toolbar) && node.getBoundingClientRect().bottom > toolbarRect.bottom,
          )
          .map(describe),
      };
    },
    { boxSelector: BOX, toolbarSelector: TOOLBAR },
  );

  expect(geometry, `no composer rendered at ${BOX}`).not.toBeNull();
  if (!geometry) return;

  // The resting composer: nothing between the box's edges and the two rows the
  // insets are measured from.
  expect(geometry.above, "something renders above the textarea").toEqual([]);
  expect(geometry.below, "something renders below the toolbar row").toEqual([]);

  // Rects come back fractional, and the device scale a runner reports moves
  // the last digit, so the comparisons hold to the nearest pixel. The drift
  // this spec exists to catch is a whole padding step wide.
  //
  // The floor derives the role's line box rather than a number that once
  // matched it.
  expect(geometry.declaredFloor).toBeCloseTo(geometry.lineBox, 0);
  expect(geometry.textareaHeight).toBeCloseTo(geometry.lineBox, 0);

  // Nothing but the box's own padding sits above the text, so the two ends of
  // the box measure the same. An asymmetric pad on the textarea shows up here
  // as a top inset larger than the bottom one.
  expect(geometry.topInset).toBeCloseTo(geometry.declaredInset, 0);
  expect(geometry.topInset).toBeCloseTo(geometry.bottomInset, 0);
});
