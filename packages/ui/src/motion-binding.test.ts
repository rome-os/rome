import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "@rstest/core";
import { compile } from "tailwindcss";

const DURATION_STEPS = [150, 200, 300] as const;
const EASINGS = ["out-expo", "in-out-travel"] as const;

let compiledCss: string;

beforeAll(async () => {
  const stylesheet = readFileSync(join(import.meta.dirname, "styles.css"), "utf8");
  const compiler = await compile(`${stylesheet}\n@tailwind utilities;`, {
    base: import.meta.dirname,
  });
  compiledCss = compiler.build([
    ...DURATION_STEPS.map((step) => `duration-${step}`),
    ...EASINGS.map((easing) => `ease-${easing}`),
  ]);
});

function ruleBody(className: string): string {
  return compiledCss.match(new RegExp(`\\.${className}\\s*\\{([^}]*)\\}`))?.[1] ?? "";
}

describe("the kit's Tailwind motion bindings", () => {
  it("resolves each duration utility on the scale to its Rome token", () => {
    for (const step of DURATION_STEPS) {
      expect(ruleBody(`duration-${step}`), `duration-${step}`).toContain(
        `transition-duration: var(--rome-duration-${step})`,
      );
    }
  });

  it("resolves each easing utility to its Rome token", () => {
    for (const easing of EASINGS) {
      expect(ruleBody(`ease-${easing}`), `ease-${easing}`).toContain(
        `transition-timing-function: var(--rome-ease-${easing})`,
      );
    }
  });
});
