import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";
import { readRosters } from "../check-utility-tokens.mjs";
import { checkTailwindEntrypoint, parseCss, runTailwindRules } from "../tailwind-policy.mjs";
import { classifySpacingDeclaration, spacingUtilityRule } from "./spacing.mjs";

const webDir = join(import.meta.dirname, "..", "..", "packages", "web");
const { spacing } = await readRosters();

async function violationsFor(css) {
  const root = await parseCss(css, { dependencyRoot: webDir });
  return runTailwindRules(root, [spacingUtilityRule], { spacing });
}

test("checks candidates after Tailwind compiles them in memory", async () => {
  const { violations } = await checkTailwindEntrypoint({
    entry: join(webDir, "src", "tailwind-policy-fixture.css"),
    css: `
      @import "tailwindcss" source(none);
      @theme inline {
        --spacing-4: var(--rome-space-4);
        --spacing-11: var(--rome-size-44);
      }
      @source inline("p-4 -m-4 space-x-4 -space-y-4 p-10.5 p-11 p-[7px] p-[calc(var(--rome-space-4)+7px)] w-11");
    `,
    base: webDir,
    dependencyRoot: webDir,
    rules: [spacingUtilityRule],
    context: { spacing },
  });

  assert.deepEqual(
    violations.map(({ candidate, reason }) => [candidate, reason]),
    [
      ["p-10.5", "off-scale spacing"],
      ["p-11", "off-scale spacing"],
      ["p-[7px]", "arbitrary spacing"],
      ["p-[calc(var(--rome-space-4)+7px)]", "arbitrary spacing"],
    ],
  );
});

test("checks spacing utilities expanded under custom selectors by @apply", async () => {
  const { violations } = await checkTailwindEntrypoint({
    entry: join(webDir, "src", "tailwind-policy-fixture.css"),
    css: `
      @import "tailwindcss" source(none);
      @theme inline {
        --spacing-2: var(--rome-space-2);
        --spacing-11: var(--rome-size-44);
      }
      .allowed { @apply p-2; }
      .off-roster { @apply p-11; }
      .arbitrary { @apply p-[7px]; }
    `,
    base: webDir,
    dependencyRoot: webDir,
    rules: [spacingUtilityRule],
    context: { spacing },
  });

  assert.deepEqual(
    violations.map(({ candidate, reason }) => [candidate, reason]),
    [
      ["p-11", "off-scale spacing"],
      ["p-[7px]", "arbitrary spacing"],
    ],
  );
});

test("rejects emitted spacing steps outside the roster and arbitrary lengths", async () => {
  const violations = await violationsFor(
    [
      ".p-11{padding:var(--rome-size-44)}",
      ".p-\\[7px\\]{padding:7px}",
      ".p-\\[1px\\]{padding:1px}",
      ".gap-px{gap:1px}",
      ".sm\\:gap-2{gap:var(--rome-space-2)}",
      ".w-11{width:var(--rome-size-44)}",
      ".space-x-11{:where(&>:not(:last-child)){margin-inline-end:calc(calc(var(--spacing)*11)*1)}}",
      ".space-y-\\[7px\\]{:where(&>:not(:last-child)){margin-block-end:calc(7px*1)}}",
    ].join(""),
  );

  assert.deepEqual(
    violations.map(({ candidate, reason }) => [candidate, reason]),
    [
      ["p-11", "off-scale spacing"],
      ["p-[7px]", "arbitrary spacing"],
      ["p-[1px]", "arbitrary spacing"],
      ["gap-px", "arbitrary spacing"],
      ["space-x-11", "off-scale spacing"],
      ["space-y-[7px]", "arbitrary spacing"],
    ],
  );
});

test("allows roster steps, geometry tokens, and safe-area padding", async () => {
  assert.deepEqual(
    await violationsFor(
      [
        ".p-4{padding:var(--rome-space-4)}",
        ".px-token{padding-inline:var(--badge-px)}",
        ".pr-token{padding-right:calc(var(--field-px-md) - 4px)}",
        ".py-row{padding-block:var(--row-py-sm)}",
        ".pb-safe{padding-bottom:calc(1rem + var(--rome-safe-area-bottom))}",
        ".mx-auto{margin-inline:auto}",
      ].join(""),
    ),
    [],
  );
});

test("rejects unknown variables, literal fallbacks, and invalid roster expressions", () => {
  assert.equal(
    classifySpacingDeclaration({
      candidate: "gap-[var(--unknown-spacing)]",
      property: "gap",
      value: "var(--unknown-spacing)",
      spacing,
    }),
    "arbitrary spacing",
  );
  assert.equal(
    classifySpacingDeclaration({
      candidate: "gap-11",
      property: "gap",
      value: "var(--rome-space-11)",
      spacing,
    }),
    "off-scale spacing",
  );
  assert.equal(
    classifySpacingDeclaration({
      candidate: "px-[var(--badge-px,7px)]",
      property: "padding-inline",
      value: "var(--badge-px, 7px)",
      spacing,
    }),
    "arbitrary spacing",
  );
  assert.equal(
    classifySpacingDeclaration({
      candidate: "p-[calc(var(--rome-space-2)+var(--rome-space-4))]",
      property: "padding",
      value: "calc(var(--rome-space-2) + var(--rome-space-4))",
      spacing,
    }),
    "arbitrary spacing",
  );
});
