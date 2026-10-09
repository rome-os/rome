import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "@rstest/core";

const srcDir = import.meta.dirname;
const stylesheet = readFileSync(join(srcDir, "styles.css"), "utf8");

const sourced = new Set(
  [...stylesheet.matchAll(/@source\s+"\.\/([^"]+)";/g)].map((match) => match[1]),
);

/**
 * The modules whose class strings ship as markup. `AutoPortal` and friends
 * carry no `className` at all, so they have nothing for Tailwind to find and
 * are legitimately absent from the registry.
 */
const components = readdirSync(srcDir)
  .filter((name) => name.endsWith(".tsx") && !name.endsWith(".test.tsx"))
  .filter((name) => readFileSync(join(srcDir, name), "utf8").includes("className"));

/**
 * Plain `.ts` helpers that hand class strings to a component, such as
 * `glyph-edge.ts`. They carry no `className`, so they are found by an
 * arbitrary-value utility (`pl-[…]`) inside a string literal instead.
 */
const classModules = readdirSync(srcDir)
  .filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts"))
  .filter((name) =>
    /["'`][^"'`]*\b[a-z]+(?:-[a-z]+)*-\[[^\]]+\]/.test(readFileSync(join(srcDir, name), "utf8")),
  );

describe("the kit stylesheet's @source registry", () => {
  it.each(components)("opts %s back into a consumer's Tailwind scan", (module) => {
    // Tailwind v4 skips node_modules, so an unregistered module's utilities —
    // its grid template, its `has-[>svg]` column, its token classes — are
    // simply absent from a consumer's compiled CSS. The component still
    // renders, and every DOM/class-token test still passes; it just paints
    // undressed in every host but this repo.
    expect(sourced).toContain(module);
  });

  it("finds the glyph-edge helper among the class-emitting .ts modules", () => {
    expect(classModules).toContain("glyph-edge.ts");
  });

  it.each(classModules)("opts the %s helper into a consumer's Tailwind scan", (module) => {
    expect(sourced).toContain(module);
  });

  it("keeps the co-located tests out, so assertion fixtures never reach a consumer's CSS", () => {
    const tests = readdirSync(srcDir).filter((name) => name.endsWith(".test.tsx"));

    expect(tests.length).toBeGreaterThan(0);
    for (const test of tests) {
      expect(sourced).not.toContain(test);
    }
  });

  it("registers nothing that no longer exists", () => {
    const present = new Set(readdirSync(srcDir));

    for (const entry of sourced) {
      expect(present).toContain(entry);
    }
  });
});
