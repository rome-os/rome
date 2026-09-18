import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "@rstest/core";

const stylesheet = readFileSync(join(import.meta.dirname, "styles.css"), "utf8").replace(
  /\/\*[\s\S]*?\*\//g,
  "",
);

function readRootHostDeclarations(): Map<string, string> {
  const declarations = new Map<string, string>();

  for (const match of stylesheet.matchAll(/:root\s*,\s*:host\s*\{([^}]+)\}/g)) {
    for (const declaration of match[1].matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/g)) {
      declarations.set(declaration[1], declaration[2].trim().replace(/\s+/g, " "));
    }
  }

  return declarations;
}

const declarations = readRootHostDeclarations();

/**
 * Resolves a token to a pixel count by following its `var()` chain and folding
 * the one `calc()` shape these declarations use. Enough to check a relation
 * between two tokens without a browser.
 */
function resolvePx(name: string): number {
  const value = declarations.get(name);
  if (value === undefined) throw new Error(`no declaration for ${name}`);

  const sum = value.matchAll(/var\((--[a-z0-9-]+)\)/g);
  const terms = [...sum].map((match) => resolvePx(match[1]));
  if (terms.length > 0) return terms.reduce((total, term) => total + term, 0);

  const rem = value.match(/^([\d.]+)rem$/);
  if (rem) return Number(rem[1]) * 16;

  const px = value.match(/^([\d.]+)px$/);
  if (px) return Number(px[1]);

  throw new Error(`cannot resolve ${name}: ${value}`);
}

function declarationsWithPrefix(prefix: string): Record<string, string> {
  return Object.fromEntries([...declarations].filter(([name]) => name.startsWith(prefix)));
}

describe("kit-owned constant tokens", () => {
  it("ships the complete spacing, box-size, and radius scales", () => {
    expect(declarationsWithPrefix("--rome-space-")).toEqual({
      "--rome-space-0": "0",
      "--rome-space-1": "0.25rem",
      "--rome-space-2": "0.5rem",
      "--rome-space-3": "0.75rem",
      "--rome-space-4": "1rem",
      "--rome-space-5": "1.25rem",
      "--rome-space-6": "1.5rem",
      "--rome-space-7": "1.75rem",
      "--rome-space-8": "2rem",
      "--rome-space-9": "2.25rem",
      "--rome-space-10": "2.5rem",
      "--rome-space-12": "3rem",
      "--rome-space-16": "4rem",
      "--rome-space-20": "5rem",
      "--rome-space-24": "6rem",
    });
    expect(declarationsWithPrefix("--rome-size-")).toEqual({
      "--rome-size-4": "0.25rem",
      "--rome-size-6": "0.375rem",
      "--rome-size-8": "0.5rem",
      "--rome-size-10": "0.625rem",
      "--rome-size-12": "0.75rem",
      "--rome-size-14": "0.875rem",
      "--rome-size-16": "1rem",
      "--rome-size-20": "1.25rem",
      "--rome-size-24": "1.5rem",
      "--rome-size-28": "1.75rem",
      "--rome-size-32": "2rem",
      "--rome-size-36": "2.25rem",
      "--rome-size-40": "2.5rem",
      "--rome-size-44": "2.75rem",
      "--rome-size-48": "3rem",
      "--rome-size-56": "3.5rem",
      "--rome-size-64": "4rem",
    });
    expect(declarationsWithPrefix("--rome-radius-")).toEqual({
      "--rome-radius-4": "4px",
      "--rome-radius-8": "8px",
      "--rome-radius-12": "12px",
      "--rome-radius-16": "16px",
      "--rome-radius-full": "9999px",
    });
  });

  it("ships typography, shadcn aliases, and control geometry", () => {
    expect(declarations.get("--rome-font-sans")).toContain('"Funnel Sans"');
    expect(declarations.get("--rome-font-serif")).toBe(
      '"Petrona", "Cormorant Garamond", "Times New Roman", serif',
    );
    expect(declarations.get("--rome-font-mono")).toContain('"IBM Plex Mono"');

    expect(
      Object.fromEntries(
        [
          "--card",
          "--card-foreground",
          "--popover",
          "--popover-foreground",
          "--font-sans",
          "--font-serif",
          "--font-mono",
          "--radius",
          "--radius-sm",
          "--radius-md",
          "--radius-lg",
          "--radius-xl",
          "--control-h-sm",
          "--control-h-md",
          "--control-h-lg",
          "--control-gap",
          "--control-gap-sm",
          "--control-gap-md",
          "--control-gap-lg",
          "--control-r-sm",
          "--control-r-md",
          "--control-r-lg",
          "--control-px-start-sm",
          "--control-px-start-md",
          "--control-px-start-lg",
          "--control-px-center-sm",
          "--control-px-center-md",
          "--control-px-center-lg",
          "--field-px-sm",
          "--field-px-md",
          "--field-px-lg",
          "--badge-h",
          "--badge-px",
          "--badge-gap",
          "--row-h-sm",
          "--row-h-md",
          "--row-px-sm",
          "--row-px-md",
          "--row-py-sm",
          "--row-py-md",
        ].map((name) => [name, declarations.get(name)]),
      ),
    ).toEqual({
      "--card": "var(--surface)",
      "--card-foreground": "var(--surface-foreground)",
      "--popover": "var(--surface-elevated)",
      "--popover-foreground": "var(--surface-foreground)",
      "--font-sans": "var(--rome-font-sans)",
      "--font-serif": "var(--rome-font-serif)",
      "--font-mono": "var(--rome-font-mono)",
      "--radius": "0.625rem",
      "--radius-sm": "calc(var(--radius) - 4px)",
      "--radius-md": "calc(var(--radius) - 2px)",
      "--radius-lg": "var(--radius)",
      "--radius-xl": "calc(var(--radius) + 4px)",
      "--control-h-sm": "var(--rome-size-28)",
      "--control-h-md": "var(--rome-size-32)",
      "--control-h-lg": "var(--rome-size-44)",
      "--control-gap": "6px",
      "--control-gap-sm": "var(--control-gap)",
      "--control-gap-md": "var(--control-gap)",
      "--control-gap-lg": "var(--control-gap)",
      "--control-r-sm": "8px",
      "--control-r-md": "10px",
      "--control-r-lg": "12px",
      "--control-px-start-sm": "10px",
      "--control-px-start-md": "12px",
      "--control-px-start-lg": "16px",
      "--control-px-center-sm": "10px",
      "--control-px-center-md": "14px",
      "--control-px-center-lg": "18px",
      "--field-px-sm": "var(--control-px-start-sm)",
      "--field-px-md": "var(--control-px-start-md)",
      "--field-px-lg": "var(--control-px-start-lg)",
      "--badge-h": "22px",
      "--badge-px": "9px",
      "--badge-gap": "6px",
      "--row-h-sm": "calc(var(--control-h-sm) + var(--rome-space-2))",
      "--row-h-md": "calc(var(--control-h-md) + var(--rome-space-2))",
      "--row-px-sm": "var(--rome-space-2)",
      "--row-px-md": "var(--rome-space-3)",
      "--row-py-sm": "var(--rome-space-1)",
      "--row-py-md": "var(--rome-space-2)",
    });
  });

  // The row scale exists to stop rows drifting from the controls they hold, so
  // the relation is checked rather than left to the shape of the declaration.
  // A floor repointed at whichever `--rome-size-*` step it equals today reads
  // the same until the control scale moves, and then it strands.
  it("floors each row step 8px above the control step of the same name", () => {
    for (const step of ["sm", "md"] as const) {
      expect(resolvePx(`--row-h-${step}`) - resolvePx(`--control-h-${step}`)).toBe(8);
    }

    expect(resolvePx("--row-h-sm")).toBe(36);
    expect(resolvePx("--row-h-md")).toBe(40);
  });
});
