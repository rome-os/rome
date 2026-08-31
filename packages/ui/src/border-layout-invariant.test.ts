import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "@rstest/core";

/**
 * The kit's border rule, enforced against every component's class strings.
 *
 * `box-sizing: border-box` only absorbs a border on an axis with a specified
 * size. Controls fix their height and let their width grow with the label, so
 * on that axis the border is added to the intrinsic size like padding is.
 * Toggling one therefore moves the box, and the kit's answer is to never toggle
 * one: a component that can paint a border in any state or variant declares the
 * width unconditionally and only ever changes the color.
 *
 * Focus used to enforce this on its own — the indicator was partly a border
 * recolor, so deleting the reservation visibly broke focus. Focus is a single
 * outline now, which is the better indicator and leaves nothing watching the
 * reservation. This file is what watches it.
 */

const srcDir = import.meta.dirname;

const components = readdirSync(srcDir).filter(
  (name) => name.endsWith(".tsx") && !name.endsWith(".test.tsx"),
);

/** Source with comments removed, so prose about borders cannot satisfy a rule. */
function classStrings(source: string): string[] {
  const code = source.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/[^\n]*/g, " ");
  return [...code.matchAll(/"([^"\\\n]*)"/g), ...code.matchAll(/`([^`\\]*)`/g)].map(
    (match) => match[1] ?? "",
  );
}

/** Splits `focus-visible:-outline-offset-2` into its variants and its utility.
 *  Colons inside `[…]` and `(…)` belong to an arbitrary value, not a variant. */
function splitToken(token: string): { variants: string[]; utility: string } {
  const cuts: number[] = [];
  let depth = 0;
  for (let i = 0; i < token.length; i++) {
    const char = token[i];
    if (char === "[" || char === "(") depth++;
    else if (char === "]" || char === ")") depth--;
    else if (char === ":" && depth === 0) cuts.push(i);
  }
  const last = cuts.at(-1);
  if (last === undefined) return { variants: [], utility: token };
  const variants: string[] = [];
  let start = 0;
  for (const cut of cuts) {
    variants.push(token.slice(start, cut));
    start = cut + 1;
  }
  return { variants, utility: token.slice(last + 1) };
}

/** `border`, `border-2`, `border-b`, `border-x-4`, `border-none` — anything that
 *  decides whether an edge occupies space. Color (`border-border`), style
 *  (`border-dashed`) and the table properties (`border-collapse`) do not. */
const BORDER_WIDTH = /^-?border(-[trblxyse])?(-\d+)?$/;
const BORDER_STYLE_OR_TABLE =
  /^border-(dashed|dotted|solid|double|hidden|none|collapse|separate|spacing(-.+)?)$/;

function isBorderWidth(utility: string): boolean {
  return BORDER_WIDTH.test(utility) || utility === "border-none";
}

function isZeroWidth(utility: string): boolean {
  return /^border(-[trblxyse])?-0$/.test(utility) || utility === "border-none";
}

function isBorderColor(utility: string): boolean {
  if (!utility.startsWith("border-")) return false;
  if (isBorderWidth(utility) || BORDER_STYLE_OR_TABLE.test(utility)) return false;
  return true;
}

/**
 * A variant that moves the rule off this element and onto a different box —
 * a pseudo-element, or a descendant/child the selector reaches into. Those
 * boxes are not the component's own, so a border on them is ordinary layout
 * rather than a toggle on the control. `after:border-b-2` (the Tabs underline)
 * and `[&_tr]:border-b` (Table's dividers) are the live cases.
 */
const PSEUDO_ELEMENTS = new Set([
  "after",
  "before",
  "file",
  "placeholder",
  "marker",
  "selection",
  "backdrop",
  "first-letter",
  "first-line",
]);

function targetsAnotherBox(variants: string[]): boolean {
  return variants.some(
    (variant) =>
      PSEUDO_ELEMENTS.has(variant) ||
      /^\[&[\s_>+~]/.test(variant) ||
      variant === "*" ||
      variant === "**",
  );
}

type Token = { raw: string; variants: string[]; utility: string };

function tokensOf(module: string): Token[] {
  const source = readFileSync(join(srcDir, module), "utf8");
  return classStrings(source)
    .flatMap((value) => value.split(/\s+/))
    .filter(Boolean)
    .map((raw) => ({ raw, ...splitToken(raw) }))
    .filter((token) => !targetsAnotherBox(token.variants));
}

describe("border widths are unconditional", () => {
  it.each(components)("%s toggles no border width on a state or variant", (module) => {
    const conditional = tokensOf(module)
      .filter((token) => token.variants.length > 0 && isBorderWidth(token.utility))
      .map((token) => token.raw);

    // A width behind a variant is the toggle this rule exists to forbid: the
    // state that adds it is the state the box changes size in. Reserve the
    // width in the base and let the variant name a color instead.
    expect(conditional).toEqual([]);
  });
});

describe("a paintable border reserves its width", () => {
  it.each(components)("%s declares a base width wherever it names a border color", (module) => {
    const tokens = tokensOf(module);
    const colors = tokens.filter((token) => isBorderColor(token.utility)).map((token) => token.raw);
    if (colors.length === 0) return;

    // Naming a color means some state or variant paints an edge. Unless a
    // nonzero width is on the element unconditionally, that paint either
    // resizes the box or — where the width is zeroed — silently does nothing,
    // which is how a Calendar day once lost half its focus indicator.
    const reserved = tokens.some(
      (token) =>
        token.variants.length === 0 && isBorderWidth(token.utility) && !isZeroWidth(token.utility),
    );

    expect(reserved, `${module} names ${colors.join(", ")} with no unconditional width`).toBe(true);
  });
});
