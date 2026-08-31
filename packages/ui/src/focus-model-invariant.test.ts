import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "@rstest/core";

/**
 * The kit's focus model, enforced against every component's class strings.
 *
 * Focus is one `outline`. Not a `ring`, because forced-colors mode drops
 * `box-shadow` and keeps `outline`, so a ring leaves a keyboard user in High
 * Contrast with no indicator at all. Not a border recolor either, because that
 * makes the indicator depend on a border existing, and a border removed for a
 * visual reason then silently halves it.
 *
 * The recipe has three parts and needs all three. Components carry a base
 * `outline-none`, which sets `--tw-outline-style: none`, and Tailwind's
 * `outline-2` emits `outline-style: var(--tw-outline-style)`. A focus state
 * that names a width but no style therefore computes to no outline at all —
 * the control simply stops showing focus, and nothing reports it.
 *
 * Rules are per variant group: `focus-visible:` and `aria-invalid:` are
 * checked independently, so a complete focus recipe cannot vouch for an
 * incomplete invalid one. `docs/design-system.md#focus-and-invalid-states`
 * carries the prose.
 */

const srcDir = import.meta.dirname;

const components = readdirSync(srcDir).filter(
  (name) => name.endsWith(".tsx") && !name.endsWith(".test.tsx"),
);

/** Source with comments stripped, so prose about focus cannot satisfy a rule. */
function classTokens(source: string): string[] {
  const code = source.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/[^\n]*/g, " ");
  return [...code.matchAll(/"([^"\\\n]*)"/g), ...code.matchAll(/`([^`\\]*)`/g)]
    .flatMap((match) => (match[1] ?? "").split(/\s+/))
    .filter(Boolean);
}

/** Splits a token into its variant chain and its utility. Colons inside `[…]`
 *  and `(…)` belong to an arbitrary value, not to a variant. */
function split(token: string): { variants: string; utility: string } {
  let depth = 0;
  let lastCut = -1;
  for (let i = 0; i < token.length; i++) {
    const char = token[i];
    if (char === "[" || char === "(") depth++;
    else if (char === "]" || char === ")") depth--;
    else if (char === ":" && depth === 0) lastCut = i;
  }
  return lastCut === -1
    ? { variants: "", utility: token }
    : { variants: token.slice(0, lastCut), utility: token.slice(lastCut + 1) };
}

/** A variant chain that fires on focus or on the invalid state. */
const isIndicatorVariant = (variants: string) =>
  /focus|focused|aria-invalid/.test(variants) && variants !== "";

const isOutlineWidth = (u: string) => /^outline-\d+$/.test(u);
const isOutlineStyle = (u: string) => /^outline-(solid|dashed|dotted|double|none|hidden)$/.test(u);
const isOutlineOffset = (u: string) => /^-?outline-offset-\d+$/.test(u);
const isOutlineColor = (u: string) =>
  u.startsWith("outline-") && !isOutlineWidth(u) && !isOutlineStyle(u) && !isOutlineOffset(u);

type Grouped = Map<string, string[]>;

function indicatorGroups(module: string): Grouped {
  const groups: Grouped = new Map();
  for (const raw of classTokens(readFileSync(join(srcDir, module), "utf8"))) {
    const { variants, utility } = split(raw);
    if (!isIndicatorVariant(variants)) continue;
    groups.set(variants, [...(groups.get(variants) ?? []), utility]);
  }
  return groups;
}

describe("focus is drawn with an outline", () => {
  it.each(components)("%s draws no focus or invalid state with a ring", (module) => {
    const rings = [...indicatorGroups(module)]
      .flatMap(([variants, utilities]) => utilities.map((u) => `${variants}:${u}`))
      .filter((token) => /:ring(-|$)/.test(token));

    // `ring-*` is a box-shadow. Forced-colors mode drops it and keeps outlines,
    // so a ring is an indicator that disappears for the users most likely to
    // rely on it.
    expect(rings).toEqual([]);
  });

  it.each(components)("%s draws no focus or invalid state with a border", (module) => {
    const borders = [...indicatorGroups(module)]
      .flatMap(([variants, utilities]) => utilities.map((u) => `${variants}:${u}`))
      .filter((token) => /:border(-|$)/.test(token));

    // A border half couples the indicator to a border existing. Removing that
    // border for a visual reason then deletes part of focus with nothing
    // reporting it — `border-layout-invariant.test.ts` guards the other side.
    expect(borders).toEqual([]);
  });
});

describe("an outline indicator is written in full", () => {
  it.each(components)("%s names a style and a color wherever it names a width", (module) => {
    const incomplete: string[] = [];

    for (const [variants, utilities] of indicatorGroups(module)) {
      if (!utilities.some(isOutlineWidth)) continue;

      const missing = [
        utilities.some(isOutlineStyle) ? null : "outline-<style>",
        utilities.some(isOutlineColor) ? null : "outline-<color>",
      ].filter(Boolean);

      if (missing.length > 0) incomplete.push(`${variants}: missing ${missing.join(" and ")}`);
    }

    // The base `outline-none` sets --tw-outline-style:none and a width utility
    // reads that variable, so a width without a style renders nothing at all.
    expect(incomplete).toEqual([]);
  });
});
