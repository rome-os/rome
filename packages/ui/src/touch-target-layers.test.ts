import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "@rstest/core";

const stylesheet = readFileSync(join(import.meta.dirname, "styles.css"), "utf8");

/**
 * Every rule for `selector` in the sheet, paired with the `@layer` names
 * enclosing it. Comments are stripped first — they discuss the selector and
 * would otherwise register as rules.
 */
function rulesFor(css: string, selector: string): { layers: string[]; declarations: string }[] {
  const source = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const rules: { layers: string[]; declarations: string }[] = [];
  const open: string[] = [];
  let preludeStart = 0;

  for (let i = 0; i < source.length; i++) {
    const char = source[i];
    if (char === "{") {
      const prelude = source.slice(preludeStart, i).trim();
      open.push(prelude);
      if (prelude.split(",").some((entry) => entry.trim() === selector)) {
        let depth = 1;
        let end = i + 1;
        while (end < source.length && depth > 0) {
          if (source[end] === "{") depth++;
          else if (source[end] === "}") depth--;
          end++;
        }
        rules.push({
          layers: open
            .filter((entry) => entry.startsWith("@layer"))
            .map((entry) => entry.slice("@layer".length).trim()),
          declarations: source.slice(i + 1, end - 1),
        });
      }
      preludeStart = i + 1;
    } else if (char === "}") {
      open.pop();
      preludeStart = i + 1;
    } else if (char === ";") {
      preludeStart = i + 1;
    }
  }

  return rules;
}

/**
 * `.touch-target` raises a control to the 44px touch floor on a pointerless
 * device. Which layer each half sits in *is* the behavior, and getting it
 * wrong fails silently — the utility still applies, just to the wrong things.
 *
 * The failure these pin actually shipped: with `display` beside the floor in
 * the unlayered rule, it outranked every display utility, so `hidden` on a
 * touch device rendered the control anyway.
 *
 * The behavior itself needs a real cascade and real layout, so it is measured
 * in `packages/web/e2e/touch-target.spec.ts`. These are the cheap structural
 * half, and they run without a browser.
 */
describe("the touch-target cascade contract", () => {
  const rules = rulesFor(stylesheet, ".touch-target");

  it("splits the floor and the display default into separate rules", () => {
    expect(rules).toHaveLength(2);
  });

  it("leaves the floor unlayered, where a min-w-* utility cannot remove it", () => {
    const floor = rules.find((rule) => rule.declarations.includes("min-width"));

    expect(floor?.layers).toEqual([]);
  });

  it("states the floor as a minimum, so a larger control keeps its size", () => {
    const floor = rules.find((rule) => rule.declarations.includes("min-width"));

    // `width`/`height` here would shrink anything already above the floor.
    expect(floor?.declarations).not.toMatch(/(?:^|[\s;])(?:width|height)\s*:/);
  });

  it("keeps the display default in `base`, so a caller's `hidden` still wins", () => {
    const display = rules.find((rule) => rule.declarations.includes("display"));

    expect(display?.layers).toEqual(["base"]);
  });
});

/**
 * `.touch-hit` extends a control's hit area to 44px on a pointerless device
 * through a `::before`, leaving the box alone. Its geometry is measured in
 * `packages/web/e2e/phone-touch-reach.spec.ts`; these pin the layering.
 */
describe("the touch-hit cascade contract", () => {
  const hitArea = rulesFor(stylesheet, ".touch-hit::before");
  const anchor = rulesFor(stylesheet, ".touch-hit");

  it("leaves the hit area unlayered, as `touch-target` leaves its floor", () => {
    expect(hitArea).toHaveLength(1);
    expect(hitArea[0]?.layers).toEqual([]);
  });

  it("only ever grows the hit area past the control's own box", () => {
    // `max(100%, 44px)`: a control already past the floor on an axis keeps
    // its own extent there rather than being cut down to 44px.
    expect(hitArea[0]?.declarations).toMatch(/width:\s*max\(100%,/);
    expect(hitArea[0]?.declarations).toMatch(/height:\s*max\(100%,/);
  });

  it("never sets `display`, so `before:hidden` stays a working opt-out", () => {
    // A grid packed edge to edge, such as Calendar's days, opts out this way.
    // Were the unlayered rule to set `display`, it would outrank the utility.
    expect(hitArea[0]?.declarations).not.toMatch(/(?:^|[\s;])display\s*:/);
  });

  it("anchors the hit area in `base`, so an `absolute` or `sticky` caller still wins", () => {
    expect(anchor).toHaveLength(1);
    expect(anchor[0]?.layers).toEqual(["base"]);
    expect(anchor[0]?.declarations).toContain("position: relative");
  });
});
