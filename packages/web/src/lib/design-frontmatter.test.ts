/**
 * `DESIGN.md`'s frontmatter is a hand-copied replica of the Ember light
 * mapping, the seven typography roles, and the radius and spacing scales.
 * The file itself says a value there that disagrees with `themes.ts` or
 * `styles.css` is a bug in `DESIGN.md` — and nothing enforced that, so the
 * next theme or scale edit left it silently wrong (#372).
 *
 * The slug → semantic-token mapping below is not invented for this test: it is
 * what `DESIGN.md`'s own Colors section states in prose, quoted per entry.
 * Several slugs name more than one token because the prose does ("Also the
 * `brand` token", "the `secondary` and `accent` fills"), and every token
 * listed must carry the value. A future theme that splits one of those pairs
 * fails here rather than leaving half the sentence true.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "@rstest/core";
import { getThemeDefinitions } from "./theme";
import type { ThemeDefinition } from "./themes";

const repoRoot = new URL("../../../../", import.meta.url);
const read = (path: string) => readFileSync(fileURLToPath(new URL(path, repoRoot)), "utf8");

// ─── Sources ──────────────────────────────────────────────────────────────────

interface Frontmatter {
  colors: Record<string, string>;
  typography: Record<string, Record<string, string | number>>;
  rounded: Record<string, string>;
  spacing: Record<string, string>;
}

/**
 * The frontmatter's shapes, and only those: a `key:` opening a nested block,
 * `key: "string"`, and `key: bare` (a number, or the two prose values at the
 * top). Two-space indentation, `#` comments, blank lines.
 *
 * Deliberately NOT a YAML dependency. `packages/web` has none, and adding one
 * moved the lockfile whichever version was pinned — `^2.8.2` carried both
 * `@opentelemetry/configuration` snapshots up, `2.8.2` carried two `metro`
 * snapshots down — which is a production dependency graph moved by a
 * test-only change either way.
 *
 * It REFUSES what it does not handle rather than guessing: a list item, an
 * anchor, a multi-line scalar, or an indent that is not a multiple of two all
 * throw, naming the line. A parser that silently mis-read this file would make
 * every equality below pass against the wrong value, which is worse than the
 * drift this gate exists to catch.
 */
function parseFrontmatterBlock(text: string): Record<string, unknown> {
  const root: Record<string, unknown> = {};
  const stack: Array<{ indent: number; node: Record<string, unknown> }> = [
    { indent: -2, node: root },
  ];

  text.split("\n").forEach((rawLine, index) => {
    const line = rawLine.replace(/\s+$/, "");
    if (line === "" || /^\s*#/.test(line)) return;

    const indent = line.length - line.trimStart().length;
    const where = `DESIGN.md frontmatter line ${index + 1}: ${rawLine}`;
    if (indent % 2 !== 0) throw new Error(`indent is not a multiple of two — ${where}`);

    const entry = line.trimStart().match(/^("?[\w.-]+"?):(?:\s+(.*))?$/);
    if (!entry) throw new Error(`not a \`key: value\` line — ${where}`);
    const key = entry[1].replace(/^"|"$/g, "");
    const raw = entry[2];

    while (stack.length > 1 && indent <= stack[stack.length - 1].indent) stack.pop();
    const parent = stack[stack.length - 1].node;

    if (raw === undefined) {
      const child: Record<string, unknown> = {};
      parent[key] = child;
      stack.push({ indent, node: child });
      return;
    }
    const quoted = raw.match(/^"(.*)"$/);
    if (quoted) {
      parent[key] = quoted[1];
      return;
    }
    if (/^-?\d+(\.\d+)?$/.test(raw)) {
      parent[key] = Number(raw);
      return;
    }
    if (/^[A-Za-z][\w .,'-]*$/.test(raw)) {
      parent[key] = raw;
      return;
    }
    throw new Error(`value is neither a quoted string, a number, nor a bare word — ${where}`);
  });

  return root;
}

function designFrontmatter(): Frontmatter {
  const text = read("DESIGN.md");
  const match = text.match(/^---\n([\s\S]*?)\n---\n/);
  if (!match) throw new Error("DESIGN.md has no frontmatter block");
  return parseFrontmatterBlock(match[1]) as unknown as Frontmatter;
}

/** `--name: value;` declarations from `styles.css`, last one wins. */
function cssCustomProperties(): Map<string, string> {
  const css = read("packages/ui/src/styles.css");
  const out = new Map<string, string>();
  for (const m of css.matchAll(/(--[a-z0-9-]+):\s*([^;}]+);/gi)) {
    out.set(m[1], m[2].replace(/\s+/g, " ").trim());
  }
  return out;
}

/** Follow `var(--x)` references to the literal behind them. */
function deref(properties: Map<string, string>, value: string, depth = 0): string {
  if (depth > 8) throw new Error(`var() chain does not terminate: ${value}`);
  const reference = value.match(/^var\((--[a-z0-9-]+)\)$/);
  if (!reference) return value;
  const next = properties.get(reference[1]);
  if (next === undefined) throw new Error(`styles.css has no ${reference[1]}`);
  return deref(properties, next, depth + 1);
}

const ember = (): ThemeDefinition => {
  const theme = getThemeDefinitions().find((t) => t.id === "ember");
  if (!theme) throw new Error("themes.ts no longer defines the ember theme");
  return theme;
};

/** The literal an Ember light semantic token resolves to, through its palette. */
function emberLight(token: string): string {
  const theme = ember();
  const declared = theme.light[token];
  if (declared === undefined) throw new Error(`ember.light declares no token "${token}"`);
  return declared.replace(/var\(--([a-z0-9-]+)\)/g, (_whole, primitive: string) => {
    const literal = theme.palette[primitive];
    if (literal === undefined) throw new Error(`ember palette has no "${primitive}"`);
    return literal;
  });
}

// ─── The mapping DESIGN.md's prose states ─────────────────────────────────────

const COLOR_SEMANTICS: Record<string, readonly string[]> = {
  // "The one interactive accent ... Also the `brand` token under Ember and Ash"
  "coral-ember": ["primary", "brand"],
  "deep-ember": ["primary-hover"], // "The `primary-hover` token under Ember"
  "ember-flare": ["ring", "info"], // "The focus ring under Ember and the Ember `info` mark"
  "linen-canvas": ["background"], // "The generic dashboard ground"
  "chat-canvas": ["chat-canvas"], // "The ground behind chat prose and its composer"
  "app-canvas": ["app-canvas"], // "The brighter ground behind compact app UI"
  "warm-paper": ["surface"], // "A raised card, panel, or table row"
  "paper-white": ["surface-elevated"], // "The highest layer, for popovers, menus, and toasts"
  // "A region recessed inside a card ... and the `muted` fill behind ghost-button hover"
  "recessed-linen": ["surface-muted", "muted"],
  // "Hover and active fill of a row or list item, and the `secondary` and `accent` fills"
  "pressed-linen": ["surface-hover", "secondary", "accent"],
  ink: ["foreground"], // "Body and control text"
  "muted-ink": ["muted-foreground"],
  "subtle-ink": ["subtle-foreground"],
  hairline: ["border", "input"], // "The default border and the input edge"
  "hairline-strong": ["border-strong"],
  scrim: ["overlay"], // "A 45% ink over the page, the `overlay` token"
  "signal-red": ["destructive"],
  "red-tint": ["destructive-bg"],
  "red-ink": ["destructive-fg"],
  "red-edge": ["destructive-border"],
  moss: ["success"],
  "moss-tint": ["success-bg"],
  "moss-ink": ["success-fg"],
  "moss-edge": ["success-border"],
  amber: ["warning"],
  "amber-tint": ["warning-bg"],
  "amber-ink": ["warning-fg"],
  "amber-edge": ["warning-border"],
  "ember-tint": ["info-bg"],
  "ember-ink": ["info-fg"],
  "ember-edge": ["info-border"],
};

/** Roles carrying a size; `serif` and `mono` declare a family and nothing else. */
const SIZED_ROLES = ["display", "title", "section", "composer", "ui", "badge", "aux"] as const;

/** `rounded.<slug>` → the custom property holding it. */
const RADIUS_PROPERTIES: Record<string, string> = {
  "4": "--rome-radius-4",
  "8": "--rome-radius-8",
  "12": "--rome-radius-12",
  "16": "--rome-radius-16",
  full: "--rome-radius-full",
  "control-sm": "--control-r-sm",
  "control-md": "--control-r-md",
  "control-lg": "--control-r-lg",
};

/** `calc(a / b)` and plain decimals, to one comparable number. */
function lineHeightRatio(value: string): number {
  const division = value.match(/^calc\(\s*([\d.]+)\s*\/\s*([\d.]+)\s*\)$/);
  if (division) return Number(division[1]) / Number(division[2]);
  const plain = Number(value);
  if (Number.isNaN(plain))
    throw new Error(`line height is neither a number nor calc(a / b): ${value}`);
  return plain;
}

/** The frontmatter rounds; `styles.css` divides. Four places is what it prints. */
const round4 = (n: number) => Math.round(n * 10_000) / 10_000;

/** `"Funnel Sans", ui-sans-serif` and `Funnel Sans, ui-sans-serif` are one stack. */
const normalizeFamily = (stack: string) =>
  stack
    .split(",")
    .map((part) => part.trim().replace(/^["']|["']$/g, ""))
    .join(", ");

// ─── The gate ─────────────────────────────────────────────────────────────────

describe("DESIGN.md frontmatter", () => {
  const frontmatter = designFrontmatter();
  const properties = cssCustomProperties();

  it("reads the three sources it compares", () => {
    // Controls. Every assertion below is an equality, so a source that parsed
    // to nothing would make the whole file pass by having nothing to compare.
    expect(Object.keys(frontmatter.colors).length).toBeGreaterThan(20);
    expect(properties.size).toBeGreaterThan(100);
    expect(Object.keys(ember().light).length).toBeGreaterThan(20);
  });

  it("names a semantic token for every colour, and only tokens that exist", () => {
    expect(Object.keys(COLOR_SEMANTICS).sort()).toEqual(Object.keys(frontmatter.colors).sort());
    for (const tokens of Object.values(COLOR_SEMANTICS)) {
      expect(tokens.length).toBeGreaterThan(0);
      for (const token of tokens) expect(() => emberLight(token)).not.toThrow();
    }
  });

  it("records the Ember light value of each semantic token it names", () => {
    for (const [slug, tokens] of Object.entries(COLOR_SEMANTICS)) {
      for (const token of tokens) {
        expect(`${slug} = ${emberLight(token)}`).toBe(`${slug} = ${frontmatter.colors[slug]}`);
      }
    }
  });

  it("records the size, weight, line height and letter spacing styles.css gives each role", () => {
    expect(Object.keys(frontmatter.typography).sort()).toEqual(
      [...SIZED_ROLES, "serif", "mono"].sort(),
    );
    for (const role of SIZED_ROLES) {
      const declared = frontmatter.typography[role];
      expect(`${role} size`).toBe(`${role} size`);
      expect({
        role,
        fontSize: declared.fontSize,
        fontWeight: declared.fontWeight,
        lineHeight: declared.lineHeight,
        // `styles.css` owns `--text-<role>--letter-spacing` too, and the
        // frontmatter copies it. Left out of the comparison, editing either
        // copy leaves the two inconsistent while this gate stays green.
        letterSpacing: String(declared.letterSpacing),
      }).toEqual({
        role,
        fontSize: deref(properties, properties.get(`--text-${role}`) ?? ""),
        fontWeight: Number(properties.get(`--text-${role}--font-weight`)),
        lineHeight: round4(
          lineHeightRatio(deref(properties, properties.get(`--text-${role}--line-height`) ?? "")),
        ),
        letterSpacing: deref(properties, properties.get(`--text-${role}--letter-spacing`) ?? ""),
      });
    }
  });

  it("records the font stacks behind sans, serif and mono", () => {
    const stack = (property: string) => normalizeFamily(deref(properties, `var(${property})`));
    for (const role of SIZED_ROLES) {
      expect(normalizeFamily(String(frontmatter.typography[role].fontFamily))).toBe(
        stack("--rome-font-sans"),
      );
    }
    expect(normalizeFamily(String(frontmatter.typography.serif.fontFamily))).toBe(
      stack("--rome-font-serif"),
    );
    expect(normalizeFamily(String(frontmatter.typography.mono.fontFamily))).toBe(
      stack("--rome-font-mono"),
    );
  });

  it("records the radius scale styles.css defines", () => {
    expect(Object.keys(RADIUS_PROPERTIES).sort()).toEqual(Object.keys(frontmatter.rounded).sort());
    for (const [slug, property] of Object.entries(RADIUS_PROPERTIES)) {
      expect(`rounded.${slug} = ${properties.get(property)}`).toBe(
        `rounded.${slug} = ${frontmatter.rounded[slug]}`,
      );
    }
  });

  it("records the spacing scale styles.css defines", () => {
    const steps = [...properties.keys()]
      .map((name) => name.match(/^--rome-space-(\d+)$/)?.[1])
      .filter((step): step is string => step !== undefined);
    expect(steps.sort()).toEqual(Object.keys(frontmatter.spacing).sort());
    for (const step of steps) {
      expect(`spacing.${step} = ${properties.get(`--rome-space-${step}`)}`).toBe(
        `spacing.${step} = ${frontmatter.spacing[step]}`,
      );
    }
  });
});
