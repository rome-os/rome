import { readFileSync } from "node:fs";
import { join } from "node:path";
import { compile } from "tailwindcss";
import { beforeAll, describe, expect, it } from "@rstest/core";
import { TYPOGRAPHY_ROLES } from "./typography-roles.js";

// Each role names the step it reads, and the scales below hold the literals —
// the same split the stylesheet makes, so a retune shows up as one changed
// step name here rather than as a value edited in two places.
const roles = {
  display: { size: 30, lineHeight: 120, weight: 400 },
  title: { size: 20, lineHeight: 120, weight: 400 },
  section: { size: 15, lineHeight: 133, weight: 500 },
  body: { size: 16, lineHeight: 125, weight: 400 },
  ui: { size: 14, lineHeight: 143, weight: 400 },
  badge: { size: 13, lineHeight: 123, weight: 500 },
  aux: { size: 13, lineHeight: 123, weight: 400 },
} as const;

const SPACING_GRID_PX = 4;

const fontSizes = {
  13: "0.8125rem",
  14: "0.875rem",
  15: "0.9375rem",
  16: "1rem",
  18: "1.125rem",
  20: "1.25rem",
  22: "1.375rem",
  24: "1.5rem",
  30: "1.875rem",
} as const;

const lineHeights = {
  120: "1.2",
  123: "calc(1 / 0.8125)",
  125: "1.25",
  127: "calc(1.75 / 1.375)",
  133: "calc(4 / 3)",
  143: "calc(1.25 / 0.875)",
} as const;

/** The ratio a step holds, for arithmetic the `calc()` strings above can't do. */
const ratioOf: Record<keyof typeof lineHeights, number> = {
  120: 1.2,
  123: 1 / 0.8125,
  125: 1.25,
  127: 1.75 / 1.375,
  133: 1.25 / 0.9375,
  143: 1.25 / 0.875,
};

let compiledCss: string;

beforeAll(async () => {
  const stylesheet = readFileSync(join(import.meta.dirname, "styles.css"), "utf8");
  const compiler = await compile(
    `${stylesheet}\n@theme { --tracking-wide: 0.025em; }\n@tailwind utilities;`,
    {
      base: import.meta.dirname,
    },
  );

  compiledCss = compiler.build([
    ...Object.keys(roles).map((role) => `text-${role}`),
    "tracking-wide",
  ]);
});

describe("typography role utilities", () => {
  // Without this, a role added to the stylesheet and to the merger's list
  // would still slip past the value assertions below, which run off the local
  // table rather than off the stylesheet.
  it("checks the values of every role the kit registers", () => {
    expect(Object.keys(roles)).toEqual(TYPOGRAPHY_ROLES);
  });

  it.each(Object.entries(fontSizes))("holds font size step %s in rem", (step, value) => {
    expect(compiledCss).toContain(`--rome-font-size-${step}: ${value};`);
  });

  it.each(Object.entries(lineHeights))("holds line height step %s unitless", (step, value) => {
    expect(compiledCss).toContain(`--rome-line-height-${step}: ${value};`);
  });

  it.each(Object.entries(roles))("emits text-%s as one self-contained utility", (role, {
    size,
    lineHeight,
    weight,
  }) => {
    expect(compiledCss).toContain(`--text-${role}: var(--rome-font-size-${size});`);
    expect(compiledCss).toContain(
      `--text-${role}--line-height: var(--rome-line-height-${lineHeight});`,
    );
    expect(compiledCss).toContain(`--text-${role}--letter-spacing: 0;`);
    expect(compiledCss).toContain(`--text-${role}--font-weight: ${weight};`);

    const utility = compiledCss.match(new RegExp(`\\.text-${role} \\{([^}]*)\\}`))?.[1];
    expect(utility).toContain(`font-size: var(--text-${role});`);
    expect(utility).toContain(`line-height: var(--tw-leading, var(--text-${role}--line-height));`);
    expect(utility).toContain(
      `letter-spacing: var(--tw-tracking, var(--text-${role}--letter-spacing));`,
    );
    expect(utility).toContain(
      `font-weight: var(--tw-font-weight, var(--text-${role}--font-weight));`,
    );
  });

  // The rule that picks a line height, restated as arithmetic: the smallest
  // multiple of 4px at or above the 1.2 descender floor. Asserting the derived
  // box rather than "some multiple of 4" is what catches a ratio picked by eye
  // that happens to land on the grid one step too loose.
  it.each(Object.entries(roles))("composes text-%s to its derived line box", (_role, {
    size,
    lineHeight,
  }) => {
    const derived = SPACING_GRID_PX * Math.ceil((size * 1.2) / SPACING_GRID_PX);
    const box = size * ratioOf[lineHeight];

    expect(box).toBeCloseTo(derived, 10);
  });

  it("does not inherit tracking from a tracking-wide wrapper", () => {
    expect(compiledCss).toMatch(/@property --tw-tracking \{[\s\S]*?inherits: false;[\s\S]*?\}/);
    for (const role of Object.keys(roles)) {
      expect(compiledCss).toContain(`--text-${role}--letter-spacing: 0;`);
    }
  });
});
