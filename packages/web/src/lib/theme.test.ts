import { readFileSync } from "node:fs";
import { INHERITED_TOKENS } from "../../../ui/src/token-contract";
import { describe, expect, it } from "@rstest/core";
import {
  buildThemeCss,
  DEFAULT_THEME_NAME,
  getThemeDefinitions,
  SUPERSEDED_THEME_CSS_CACHE_KEYS,
  THEME_CSS_CACHE_KEY,
  THEME_NAME_STORAGE_KEY,
  THEME_STORAGE_KEY,
  THEME_STYLE_ELEMENT_ID,
} from "./theme";
import type { ThemeDefinition } from "./themes";

/** OKLCH lightness of a palette value, for the ramp-ordering assertion below.
 *  Handles the two forms a palette uses: `oklch(L C H)` and `#rrggbb`. */
function oklchLightness(value: string): number {
  const oklch = value.match(/^oklch\(([\d.]+)/);
  if (oklch) return Number(oklch[1]);

  const hex = value.match(/^#([0-9a-f]{6})$/i);
  if (!hex) throw new Error(`palette value is neither oklch() nor #rrggbb: ${value}`);
  const [r, g, b] = [0, 2, 4].map((i) => {
    const channel = Number.parseInt(hex[1].slice(i, i + 2), 16) / 255;
    return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  });
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
}

const sample: ThemeDefinition = {
  id: "test-theme",
  label: "Test",
  palette: { "neutral-50": "#ffffff", "neutral-950": "#101010" },
  light: { background: "var(--neutral-50)" },
  dark: { background: "var(--neutral-950)" },
};

const globalsCss = readFileSync(new URL("../globals.css", import.meta.url), "utf8");

function declarationsForSelector(css: string, selector: string): Map<string, string> {
  const escapedSelector = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const rule = new RegExp(`${escapedSelector}\\s*\\{([^{}]*)\\}`, "g");
  const declarations = new Map<string, string>();

  for (const match of css.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(rule)) {
    for (const declaration of match[1].matchAll(/(--[a-z][a-z0-9-]*)\s*:\s*([^;]+);/gi)) {
      declarations.set(declaration[1], declaration[2].trim());
    }
  }

  return declarations;
}

function tokenResolves(
  name: string,
  declarations: Map<string, string>,
  resolving = new Set<string>(),
): boolean {
  const value = declarations.get(name);
  if (value === undefined || resolving.has(name)) return false;

  const resolutionPath = new Set(resolving).add(name);
  const references = [...value.matchAll(/var\(\s*(--[a-z][a-z0-9-]*)/gi)].map((match) => match[1]);
  return references.every((reference) => tokenResolves(reference, declarations, resolutionPath));
}

describe("buildThemeCss", () => {
  it("emits a light block carrying the palette and resolved light values", () => {
    const css = buildThemeCss([sample]);
    expect(css).toContain('[data-theme="test-theme"] {');
    expect(css).toContain("--neutral-50: #ffffff;");
    expect(css).toContain("--neutral-950: #101010;");
    expect(css).toContain("--background: #ffffff;");
  });

  it("emits a dark block with the resolved value for that mode", () => {
    const css = buildThemeCss([sample]);
    expect(css).toContain('[data-theme="test-theme"].dark {');
    expect(css).toContain("--background: #101010;");
  });

  it("keeps the palette out of the dark block, since it spans both modes", () => {
    const dark = buildThemeCss([sample]).split('[data-theme="test-theme"].dark {')[1];
    expect(dark).not.toContain("--neutral-50:");
  });

  it("emits semantic values without palette references", () => {
    const css = buildThemeCss(getThemeDefinitions());
    expect(css).not.toMatch(/var\(\s*--(?:neutral|red|amber|blue|green|orange)-\d+\b/);
  });

  it("resolves a palette reference inside color-mix", () => {
    const css = buildThemeCss([
      {
        ...sample,
        light: {
          ...sample.light,
          overlay: "color-mix(in srgb, var(--neutral-950) 45%, transparent)",
        },
      },
    ]);
    expect(css).toContain("--overlay: color-mix(in srgb, #101010 45%, transparent);");
  });

  it("renders one light + one dark block per theme in the input", () => {
    const css = buildThemeCss([sample, { ...sample, id: "other" }]);
    const lightBlocks = css.match(/\[data-theme="[^"]+"\] \{/g) ?? [];
    const darkBlocks = css.match(/\[data-theme="[^"]+"\]\.dark \{/g) ?? [];
    expect(lightBlocks).toHaveLength(2);
    expect(darkBlocks).toHaveLength(2);
  });

  it("produces an empty string for no themes", () => {
    expect(buildThemeCss([])).toBe("");
  });

  it("drops a token whose value tries to break out of the declaration block", () => {
    const hostile: ThemeDefinition = {
      id: "x",
      label: "X",
      palette: {
        "neutral-50": "red } @import url('https://evil.test') ;{ a: b",
        "neutral-950": "#101010",
      },
      light: { background: "var(--neutral-50)", ring: "var(--neutral-950)" },
      dark: { background: "var(--neutral-950)" },
    };
    const css = buildThemeCss([hostile]);
    // The brace-bearing value is rejected entirely — no @import reaches the CSS.
    expect(css).not.toContain("@import");
    expect(css).not.toContain("--neutral-50: red");
    // Well-formed tokens in the same theme are unaffected.
    expect(css).toContain("--ring: #101010;");
    expect(css).toContain("--background: #101010;");
  });

  it("drops a token with a non-identifier name", () => {
    const hostile: ThemeDefinition = {
      id: "x",
      label: "X",
      palette: { "neutral-50": "#ffffff" },
      light: { "bg; color:red": "blue", background: "var(--neutral-50)" },
      dark: { background: "var(--neutral-50)" },
    };
    const css = buildThemeCss([hostile]);
    expect(css).not.toContain("bg; color:red");
    expect(css).toContain("--background: #ffffff;");
  });

  it("does not resolve inherited object properties as palette entries", () => {
    const hostile: ThemeDefinition = {
      id: "x",
      label: "X",
      palette: { "neutral-50": "#ffffff" },
      light: { background: "var(--constructor)" },
      dark: { background: "var(--neutral-50)" },
    };
    expect(buildThemeCss([hostile])).toContain("--background: var(--constructor);");
  });
});

describe("theme registry", () => {
  it("ships Ember, Ash and Slate as built-in themes", () => {
    const ids = getThemeDefinitions().map((theme) => theme.id);
    expect(ids).toContain("ember");
    expect(ids).toContain("ash");
    expect(ids).toContain("slate");
  });

  it("defaults to the first registered theme", () => {
    expect(DEFAULT_THEME_NAME).toBe(getThemeDefinitions()[0].id);
  });

  it("gives every built-in theme the same token vocabulary in both halves", () => {
    // The contract: a theme maps every semantic token, in light AND dark. Drift
    // between the halves means some token is undefined in one mode.
    for (const theme of getThemeDefinitions()) {
      expect(Object.keys(theme.dark).sort()).toEqual(Object.keys(theme.light).sort());
    }
  });

  it("gives every built-in theme the same palette as every other", () => {
    // Themes differ by the values on the scale and by which step each token
    // reads — never by which primitives exist. A theme missing a name another
    // theme carries cannot be re-pointed at it without a palette edit.
    const [first, ...rest] = getThemeDefinitions();
    for (const theme of rest) {
      expect(Object.keys(theme.palette).sort()).toEqual(Object.keys(first.palette).sort());
    }
  });

  for (const theme of getThemeDefinitions()) {
    for (const mode of ["light", "dark"] as const) {
      it(`supplies every inherited token for ${theme.id} in ${mode} mode`, () => {
        const themeCss = buildThemeCss([theme]);
        // Map insertion order mirrors the live cascade: shared :root values,
        // then the active theme, then its higher-specificity dark override.
        const declarations = new Map([
          ...declarationsForSelector(globalsCss, ":root"),
          ...declarationsForSelector(themeCss, `[data-theme="${theme.id}"]`),
          ...(mode === "dark"
            ? declarationsForSelector(themeCss, `[data-theme="${theme.id}"].dark`)
            : []),
        ]);
        const unresolved = INHERITED_TOKENS.filter((token) => !tokenResolves(token, declarations));

        expect({ theme: theme.id, mode, unresolved }).toEqual({
          theme: theme.id,
          mode,
          unresolved: [],
        });
      });
    }
  }

  it("resolves every primitive a mapping reads out of that theme's own palette", () => {
    // Fail closed on a dangling reference: a semantic token pointing at a
    // primitive the theme lacks renders as an unset custom property — invisible
    // text or a transparent fill, with no build error.
    for (const theme of getThemeDefinitions()) {
      const supplied = new Set(Object.keys(theme.palette));
      for (const half of [theme.light, theme.dark]) {
        const referenced = [...JSON.stringify(half).matchAll(/var\(--([a-z0-9-]+)\)/g)].map(
          (match) => match[1],
        );
        expect(referenced.length).toBeGreaterThan(0);
        expect(referenced.filter((name) => !supplied.has(name))).toEqual([]);
      }
    }
  });

  it("keeps every palette value self-contained", () => {
    // A palette entry holds a literal or a self-contained expression. Reading
    // another custom property would re-couple the themes into one shared
    // palette, which is the thing per-theme values replace.
    for (const theme of getThemeDefinitions()) {
      for (const [name, value] of Object.entries(theme.palette)) {
        expect(`${theme.id}.${name}: ${value}`).not.toContain("var(");
      }
    }
  });

  it("orders every ramp by lightness, so a higher step is never lighter", () => {
    // The scale's one structural promise, asserted across every ramp rather
    // than the neutral one alone: a hue ramp that inverts makes its step
    // numbers meaningless just as surely, and is harder to catch by eye
    // because neighboring accent steps differ mostly in chroma.
    for (const theme of getThemeDefinitions()) {
      const families = new Set(Object.keys(theme.palette).map((name) => name.replace(/-\d+$/, "")));
      expect(families.size).toBeGreaterThan(1);

      for (const family of families) {
        const steps = Object.keys(theme.palette)
          .filter((name) => name.startsWith(`${family}-`))
          .map((name) => Number(name.slice(family.length + 1)))
          .sort((a, b) => a - b);

        const inversions = steps
          .map((step) => ({ step, lightness: oklchLightness(theme.palette[`${family}-${step}`]) }))
          .filter((row, i, rows) => i > 0 && row.lightness > rows[i - 1].lightness + 1e-9)
          .map((row) => `${family}-${row.step}`);

        expect({ theme: theme.id, family, inversions }).toEqual({
          theme: theme.id,
          family,
          inversions: [],
        });
      }
    }
  });
});

describe("no-flash bootstrap", () => {
  // The inline script in index.html runs before the bundle loads, so it cannot
  // import these names and duplicates them as literals. Drift means the
  // bootstrap reads a key nothing writes, and the page paints unstyled until
  // the bundle boots — the exact flash the cache exists to prevent.
  const html = readFileSync(new URL("../../index.html", import.meta.url), "utf8");

  it("reads the same storage keys this module writes", () => {
    for (const key of [THEME_STORAGE_KEY, THEME_NAME_STORAGE_KEY, THEME_CSS_CACHE_KEY]) {
      expect(html).toContain(`localStorage.getItem("${key}")`);
    }
  });

  it("targets the same style element injectThemeCss replaces", () => {
    expect(html).toContain(`style.id = "${THEME_STYLE_ELEMENT_ID}"`);
  });

  it("never replays a superseded cache key", () => {
    // A key left behind by an older payload shape names primitives this build
    // may no longer define.
    for (const key of SUPERSEDED_THEME_CSS_CACHE_KEYS) {
      expect(html).not.toContain(`"${key}"`);
    }
  });

  it("caches a payload that fits under the bootstrap's size cap", () => {
    // The bootstrap drops an oversized entry, which would silently reinstate
    // the flash. Read the cap out of the shell so the two cannot drift.
    const cap = Number(html.match(/css\.length < (\d+)/)?.[1]);
    expect(cap).toBeGreaterThan(0);

    for (const theme of getThemeDefinitions()) {
      expect({ theme: theme.id, fits: buildThemeCss([theme]).length < cap }).toEqual({
        theme: theme.id,
        fits: true,
      });
    }
  });
});
