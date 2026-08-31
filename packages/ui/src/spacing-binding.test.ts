import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "@rstest/core";

export const SPACING_STEPS = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 12, 16, 20, 24] as const;
const spacingSteps = new Set<number>(SPACING_STEPS);

const stylesheet = readFileSync(join(import.meta.dirname, "styles.css"), "utf8").replace(
  /\/\*[\s\S]*?\*\//g,
  "",
);

const declarations = [...stylesheet.matchAll(/--spacing-(\d+)\s*:\s*([^;{}]+);/g)].map((match) => ({
  step: Number(match[1]),
  value: match[2].trim(),
}));

describe("the kit's Tailwind spacing bindings", () => {
  it("binds exactly the documented spacing steps to spacing tokens", () => {
    expect(
      declarations
        .filter(({ value }) => value.startsWith("var(--rome-space-"))
        .map(({ step }) => step)
        .sort((a, b) => a - b),
    ).toEqual([...SPACING_STEPS]);
  });

  it("points every step at its same-numbered Rome token", () => {
    for (const { step, value } of declarations.filter(({ step }) => spacingSteps.has(step))) {
      expect(value, `--spacing-${step}`).toBe(`var(--rome-space-${step})`);
    }
  });
});
