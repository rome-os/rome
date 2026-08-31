import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "@rstest/core";

const stylesheet = readFileSync(join(import.meta.dirname, "styles.css"), "utf8");

/**
 * Every `.touch-target` rule in the sheet, paired with the `@layer` names
 * enclosing it. Comments are stripped first — they discuss the selector and
 * would otherwise register as rules.
 */
function touchTargetRules(css: string): { layers: string[]; declarations: string }[] {
  const source = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const rules: { layers: string[]; declarations: string }[] = [];
  const open: string[] = [];
  let preludeStart = 0;

  for (let i = 0; i < source.length; i++) {
    const char = source[i];
    if (char === "{") {
      const prelude = source.slice(preludeStart, i).trim();
      open.push(prelude);
      if (prelude.split(",").some((selector) => selector.trim() === ".touch-target")) {
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
  const rules = touchTargetRules(stylesheet);

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
