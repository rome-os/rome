import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "@rstest/core";

export const SPACING_STEPS = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 12, 16, 20, 24] as const;

const REM_PER_STEP = 0.25;
const BASE_GRID_PX = 4;
const RELATIVE_GAP_FLOOR = 0.11;
const MAX_PX = 96;
const ROOT_FONT_PX = 16;

function parseScale(): Array<{ step: number; px: number }> {
  const css = readFileSync(join(import.meta.dirname, "styles.css"), "utf8");
  const activeCss = css.replace(/\/\*[\s\S]*?\*\//g, "");

  return [...activeCss.matchAll(/--rome-space-(\d+)\s*:\s*([^;{}]+);/g)].map((match) => {
    const step = Number(match[1]);
    const value = match[2].trim();
    if (value === "0") return { step, px: 0 };

    const rem = value.match(/^(\d*\.?\d+)rem$/);
    return { step, px: rem ? Number(rem[1]) * ROOT_FONT_PX : Number.NaN };
  });
}

describe("--rome-space-* scale", () => {
  const scale = parseScale();
  const pxByStep = new Map(scale.map(({ step, px }) => [step, px]));
  const px = SPACING_STEPS.map((step) => pxByStep.get(step) ?? Number.NaN);

  it("carries exactly the documented steps", () => {
    expect(scale.map(({ step }) => step).sort((a, b) => a - b)).toEqual([...SPACING_STEPS]);
  });

  it("derives every value as the step number times 0.25rem", () => {
    for (const step of SPACING_STEPS) {
      expect(pxByStep.get(step), `--rome-space-${step}`).toBe(step * REM_PER_STEP * ROOT_FONT_PX);
    }
  });

  it("keeps every step on the 4px grid, inside 0 to 96px", () => {
    for (const value of px) {
      expect(value % BASE_GRID_PX).toBe(0);
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThanOrEqual(MAX_PX);
    }
  });

  it("keeps every neighbouring pair at or above the 11% relative-gap floor", () => {
    const nonZero = px.filter((value) => value > 0);
    for (let index = 1; index < nonZero.length; index++) {
      const previous = nonZero[index - 1];
      const current = nonZero[index];
      const gap = (current - previous) / previous;
      expect(gap, `${previous}px to ${current}px`).toBeGreaterThanOrEqual(RELATIVE_GAP_FLOOR);
    }
  });
});
