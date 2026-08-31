import { readdirSync, readFileSync } from "node:fs";
import { extname, join } from "node:path";
import { describe, expect, it } from "@rstest/core";

/**
 * A ratchet over the dashboard's unconverted focus indicators.
 *
 * The design system draws focus with one `outline`
 * (`docs/design-system.md#focus-and-invalid-states`). `@rome-os/ui` holds that
 * strictly — `focus-model-invariant.test.ts` in the kit fails on a ring. The
 * dashboard predates the rule and still carries hand-rolled `focus:ring-*` on
 * raw elements, mostly where a page reached past the primitives.
 *
 * Converting them all in one pass would be a large diff across unrelated
 * pages, so they convert as they are touched. This gate makes that direction
 * one-way: the count may go down and never up. It is pinned exactly rather
 * than as a ceiling, on the same reasoning as `themes-contrast.test.ts`'s
 * known-failure records — a budget with slack in it silently absorbs new debt.
 */

const srcDir = join(import.meta.dirname);

/** Every remaining site, so the failure message names them rather than only counting. */
const LEGACY_RING_FOCUS =
  /(?:^|[\s"'`])((?:[\w\-[\]()=&>*.'/]+:)*(?:focus|focus-visible|focus-within):ring(?:-[\w./[\]-]+)?)/g;

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    if (![".ts", ".tsx"].includes(extname(entry.name))) return [];
    if (entry.name.includes(".test.")) return [];
    return [path];
  });
}

function remainingSites(): string[] {
  return sourceFiles(srcDir).flatMap((path) => {
    const matches = [...readFileSync(path, "utf8").matchAll(LEGACY_RING_FOCUS)];
    return matches.map(() => path.slice(srcDir.length + 1));
  });
}

/** Lower this when you convert one. Never raise it. */
const REMAINING = 60;

describe("the ring-based focus backlog", () => {
  it("never grows, and shrinks only with the pin", () => {
    const sites = remainingSites();
    const byFile = [...new Set(sites)]
      .map((file) => `${sites.filter((s) => s === file).length}  ${file}`)
      .sort();

    // Above the pin: a new `focus:ring-*` landed. Reach for the kit primitive,
    // or write the outline recipe the design system documents.
    // Below it: conversions happened — lower REMAINING to lock the ground in,
    // or the budget quietly leaves room for the next regression.
    expect(sites.length, `remaining sites:\n${byFile.join("\n")}`).toBe(REMAINING);
  });
});
