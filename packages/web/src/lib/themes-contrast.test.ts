/**
 * WCAG contrast gate over the theme data in `themes.ts`.
 *
 * Themes are pure data: a palette of literals plus a light/dark mapping of
 * semantic tokens onto `var(--<primitive>)`. That makes every pairing the
 * design system promises resolvable to two concrete colors without a browser,
 * so the AA bar is a unit test rather than a per-PR eyeball.
 *
 * The roster below (`PAIRINGS`) is the explicit list of what gets measured, and
 * each entry says why it is in it. `KNOWN_FAILURES` carries the pairings that
 * ship below their bar today, each with its measured ratio and the reason it is
 * not a mechanical fix. Both directions are asserted: an unlisted pairing must
 * pass, and a listed one must still be failing — fixing a value forces the
 * stale entry out instead of leaving a false record behind.
 *
 * Palette semantics: `docs/ui/primitive-token/color-primitives.md`.
 * Palette-audit methodology: the `ux/color-audit` skill.
 */

import { describe, expect, it } from "@rstest/core";
import { getThemeDefinitions } from "./theme";
import type { ThemeDefinition } from "./themes";

// ─── Color math ───────────────────────────────────────────────────────────────
// WCAG 2.x relative luminance, over the two value forms a palette uses:
// `#rrggbb` and `oklch(L C H)`.

const srgbToLinear = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const linearToSrgb = (c: number) => (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055);

/** Out-of-gamut oklch inputs clamp to the nearest channel extreme, which is
 *  close enough to how a browser rasterizes them for a contrast bar. */
function oklchToSrgb(L: number, C: number, hDeg: number): [number, number, number] {
  const h = (hDeg * Math.PI) / 180;
  const [a, b] = [C * Math.cos(h), C * Math.sin(h)];
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ].map((c) => Math.min(1, Math.max(0, linearToSrgb(c)))) as [number, number, number];
}

/** Throws on an unrecognized form rather than guessing — a palette value the
 *  gate cannot read is a hole in the gate, not a pass. */
function parseColor(value: string): [number, number, number] {
  const v = value.trim().toLowerCase();

  const hex = v.match(/^#([0-9a-f]{6})$/);
  if (hex) {
    return [0, 2, 4].map((i) => Number.parseInt(hex[1].slice(i, i + 2), 16) / 255) as [
      number,
      number,
      number,
    ];
  }

  const oklch = v.match(/^oklch\(\s*([\d.]+%?)\s+([\d.]+)\s+([\d.]+)\s*\)$/);
  if (oklch) {
    const l = oklch[1].endsWith("%") ? Number(oklch[1].slice(0, -1)) / 100 : Number(oklch[1]);
    return oklchToSrgb(l, Number(oklch[2]), Number(oklch[3]));
  }

  throw new Error(`palette value is neither #rrggbb nor oklch(L C H): ${value}`);
}

function contrastRatio(fg: string, bg: string): number {
  const luminance = (color: string) => {
    const [r, g, b] = parseColor(color).map(srgbToLinear);
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const [lighter, darker] = [luminance(fg), luminance(bg)].sort((a, b) => b - a);
  return (lighter + 0.05) / (darker + 0.05);
}

// ─── The roster ───────────────────────────────────────────────────────────────

/** AA for body text. Every text role in this system is authored at weight 400,
 *  and the largest role that carries prose (`text-title`, 20px) sits below the
 *  24px large-text threshold — so no text pairing here qualifies for the 3:1
 *  bar. Roles: `packages/ui/src/typography-roles.ts`. */
const AA_TEXT = 4.5;
/** WCAG 1.4.11 non-text contrast, for a control's own indicator. */
const AA_NON_TEXT = 3;

type Pairing = { fg: string; bg: string; min: number; why: string };

/**
 * What is measured, and why each pairing earns a place.
 *
 * Admission bar: the system promises the pairing will be legible — either the
 * token names declare partnership (`primary`/`primary-foreground`, the status
 * `-fg`/`-bg` families) or a shipped component paints that text role on that
 * fill. A pairing that is merely possible is not in the roster; combinations
 * nobody declares are per-usage accidents, and flagging them would bury the
 * ones the design actually guarantees.
 *
 * Deliberately out of scope, so the gaps are known rather than assumed:
 *
 *   - Alpha compositing (`bg-primary/15`, `bg-destructive/10`, `opacity-90` on
 *     AlertDescription). The rendered color depends on a runtime backdrop, so
 *     no static pair describes it. `Button`'s destructive variant and every
 *     `-/NN` tint live here.
 *   - Dividers and field edges (`border`, `border-strong`, `input`). 1.4.11
 *     covers what identifies a control, and this system identifies a field by
 *     its fill, label and focus ring; the hairline is decoration. Every one of
 *     them measures 1.1–2.1:1 in all six theme × mode combinations, so
 *     admitting them would gate on a value nobody intends to change.
 *   - Status tint borders (`-border` on `-bg`), for the same reason: the
 *     callout is identified by its fill.
 *   - `--card` and `--popover`: the kit aliases them onto `--surface` and
 *     `--surface-elevated`, which the roster already covers.
 */
const PAIRINGS: Pairing[] = [
  // Neutral ink on the fills it is painted on. `foreground` is the page and
  // dialog ink; `surface-foreground` is Card's root.
  { fg: "foreground", bg: "background", min: AA_TEXT, why: "page canvas ink" },
  { fg: "foreground", bg: "surface", min: AA_TEXT, why: "Dialog/Sheet body ink" },
  { fg: "foreground", bg: "surface-elevated", min: AA_TEXT, why: "popover ink" },
  { fg: "foreground", bg: "surface-muted", min: AA_TEXT, why: "Badge default label" },
  { fg: "foreground", bg: "surface-hover", min: AA_TEXT, why: "hovered row label" },
  { fg: "surface-foreground", bg: "surface", min: AA_TEXT, why: "Card root ink" },
  { fg: "surface-foreground", bg: "surface-elevated", min: AA_TEXT, why: "popover root ink" },

  // The secondary text tier. CardDescription and DialogDescription read it at
  // 14px, and FieldDescription puts the same role at 12px.
  { fg: "muted-foreground", bg: "background", min: AA_TEXT, why: "muted text on the canvas" },
  { fg: "muted-foreground", bg: "surface", min: AA_TEXT, why: "Card/DialogDescription" },
  { fg: "muted-foreground", bg: "surface-elevated", min: AA_TEXT, why: "menu section labels" },
  { fg: "muted-foreground", bg: "surface-muted", min: AA_TEXT, why: "Badge muted label" },
  { fg: "muted-foreground", bg: "muted", min: AA_TEXT, why: "Avatar fallback initials" },
  { fg: "surface-muted-foreground", bg: "surface-muted", min: AA_TEXT, why: "declared partner" },

  // The third text tier. Not decorative: it is the resting state of the
  // sidebar's interactive rows, which swap to `foreground` only on hover.
  { fg: "subtle-foreground", bg: "background", min: AA_TEXT, why: "sidebar labels, 12px" },
  { fg: "subtle-foreground", bg: "surface", min: AA_TEXT, why: "Stepper labels" },

  // The accent carrying text rather than a fill — markdown links and Button's
  // `link` variant read `text-primary` straight onto a canvas or card.
  { fg: "primary", bg: "background", min: AA_TEXT, why: "link ink on the canvas" },
  { fg: "primary", bg: "surface", min: AA_TEXT, why: "markdown links in messages" },
  { fg: "primary", bg: "surface-elevated", min: AA_TEXT, why: "link ink in popovers" },

  // Solid fill + the label the token names as its partner. Some are unused
  // today; the naming convention still promises them, and the gate is what
  // makes reaching for one later safe.
  { fg: "primary-foreground", bg: "primary", min: AA_TEXT, why: "Button default label" },
  { fg: "primary-foreground", bg: "primary-hover", min: AA_TEXT, why: "Button hover label" },
  { fg: "brand-fg", bg: "brand", min: AA_TEXT, why: "declared partner" },
  { fg: "secondary-foreground", bg: "secondary", min: AA_TEXT, why: "Button secondary label" },
  { fg: "accent-foreground", bg: "accent", min: AA_TEXT, why: "focused menu item" },

  // Tinted status callouts — Alert and Badge paint `-fg` on `-bg` for all four
  // families, at 14px titles and 12px badge labels. `-fg` is the family's only
  // foreground, and roughly half its call sites paint it standalone on a plain
  // surface to colour-code status, so the roster measures it against the
  // canvases too. The bare fill carries dots and rules, not text.
  { fg: "destructive-fg", bg: "destructive-bg", min: AA_TEXT, why: "Alert destructive" },
  { fg: "destructive-fg", bg: "destructive-hover-bg", min: AA_TEXT, why: "hovered destructive" },
  { fg: "success-fg", bg: "success-bg", min: AA_TEXT, why: "Alert success" },
  { fg: "warning-fg", bg: "warning-bg", min: AA_TEXT, why: "Alert warning" },
  { fg: "warning-fg", bg: "warning-hover-bg", min: AA_TEXT, why: "hovered warning" },
  { fg: "info-fg", bg: "info-bg", min: AA_TEXT, why: "Alert info title, 14px" },

  // The same four tokens standalone. Roughly half of every `text-*-fg` call
  // site paints one on a plain canvas or card to colour-code a status — an
  // activity type, a diagnosis row, a run-status icon — with no tint behind
  // it. Those readings are what make the token chromatic rather than ink, so
  // they are measured, not assumed.
  { fg: "destructive-fg", bg: "background", min: AA_TEXT, why: "inline error text" },
  { fg: "destructive-fg", bg: "surface", min: AA_TEXT, why: "error text on a card" },
  { fg: "success-fg", bg: "background", min: AA_TEXT, why: "positive amounts, ok rows" },
  { fg: "success-fg", bg: "surface", min: AA_TEXT, why: "success status on a card" },
  { fg: "warning-fg", bg: "background", min: AA_TEXT, why: "pending-approval status" },
  { fg: "warning-fg", bg: "surface", min: AA_TEXT, why: "warning status on a card" },
  { fg: "info-fg", bg: "background", min: AA_TEXT, why: "activity-type coding" },
  { fg: "info-fg", bg: "surface", min: AA_TEXT, why: "selected menu option" },

  // `success` is the one family with no `-hover-bg`, so the composer's send
  // button hovers onto the border step instead. Its glyph is the whole control
  // — `IconButton` renders the label to `aria-label` — so the bar is the
  // non-text one, which is also why this reading sits apart from the tier
  // above: at 4.45:1 in the warm themes it would miss the text bar.
  { fg: "success-fg", bg: "success-border", min: AA_NON_TEXT, why: "hovered send glyph" },

  // The focus treatment is a single 2px `outline` in `ring`, drawn outside the
  // box at `outline-offset: 0`. Its outer boundary against the canvas is what
  // marks the control, and its inner boundary meets whatever fill the control
  // paints. Both have to separate from what they touch, so the roster measures
  // `ring` against the canvases a control sits on *and* against the opaque
  // fills a focusable control paints — `primary` (Button default, checked
  // Switch), `secondary` (Button secondary) and `input` (unchecked Switch
  // track). Transparent and alpha fills are out of scope for the reason given
  // above.
  { fg: "ring", bg: "background", min: AA_NON_TEXT, why: "outer edge on the canvas" },
  { fg: "ring", bg: "surface", min: AA_NON_TEXT, why: "outer edge on a card" },
  { fg: "ring", bg: "primary", min: AA_NON_TEXT, why: "inner edge on a Button" },
  { fg: "ring", bg: "secondary", min: AA_NON_TEXT, why: "inner edge on a secondary Button" },
  { fg: "ring", bg: "input", min: AA_NON_TEXT, why: "inner edge on a Switch track" },
];

/** Every pairing's id, pinned so shrinking the roster is an explicit edit.
 *  `PAIRINGS` is what gets measured; deleting an entry there without deleting
 *  it here fails, which is the point — a contract leaves the roster on purpose
 *  or not at all. */
const PAIRING_IDS = [
  "foreground/background",
  "foreground/surface",
  "foreground/surface-elevated",
  "foreground/surface-muted",
  "foreground/surface-hover",
  "surface-foreground/surface",
  "surface-foreground/surface-elevated",
  "muted-foreground/background",
  "muted-foreground/surface",
  "muted-foreground/surface-elevated",
  "muted-foreground/surface-muted",
  "muted-foreground/muted",
  "surface-muted-foreground/surface-muted",
  "subtle-foreground/background",
  "subtle-foreground/surface",
  "primary/background",
  "primary/surface",
  "primary/surface-elevated",
  "primary-foreground/primary",
  "primary-foreground/primary-hover",
  "brand-fg/brand",
  "secondary-foreground/secondary",
  "accent-foreground/accent",
  "destructive-fg/destructive-bg",
  "destructive-fg/destructive-hover-bg",
  "success-fg/success-bg",
  "warning-fg/warning-bg",
  "warning-fg/warning-hover-bg",
  "info-fg/info-bg",
  "destructive-fg/background",
  "destructive-fg/surface",
  "success-fg/background",
  "success-fg/surface",
  "warning-fg/background",
  "warning-fg/surface",
  "info-fg/background",
  "info-fg/surface",
  "success-fg/success-border",
  "ring/background",
  "ring/surface",
  "ring/primary",
  "ring/secondary",
  "ring/input",
];

// ─── Known failures ───────────────────────────────────────────────────────────

/**
 * Pairings shipping below their bar, with the ratio each measures today.
 *
 * An entry is a debt record, not a waiver: it belongs here only when the fix is
 * a design decision — which token moves, and how the tier reads afterwards —
 * rather than a re-point onto a deeper step the ramp already carries. A pairing
 * that can be fixed by re-pointing gets re-pointed instead of recorded. Every
 * entry is tracked by KNOWN_FAILURE_ISSUE.
 *
 * Keys are `<theme>/<mode>`.
 */
const KNOWN_FAILURE_ISSUE = "https://github.com/amantru/rome-internal/issues/2167";

type KnownFailure = { pair: string; why: string; measured: Record<string, number> };

const KNOWN_FAILURES: KnownFailure[] = [
  {
    pair: "muted-foreground/surface-muted",
    why: "Muted ink clears AA on the canvas and on cards but not on the muted fill, which sits a step darker. Fixing it moves either the ink (darkening the whole tier) or the fill (collapsing it toward the canvas).",
    measured: { "ember/light": 4.41, "slate/light": 4.34 },
  },
  {
    pair: "muted-foreground/muted",
    why: "Same two tokens as the pairing above — `muted` and `surface-muted` read the same step in both themes.",
    measured: { "ember/light": 4.41, "slate/light": 4.34 },
  },
  {
    pair: "subtle-foreground/background",
    why: "The third text tier was never held to AA. It carries 12px sidebar labels and empty-state prose, and it is the resting state of rows that only reach `foreground` on hover, so no decorative exemption applies. Raising it needs a call on whether three text tiers can coexist above 4.5:1.",
    measured: { "ember/light": 2.24, "ash/light": 4.05, "slate/light": 2.48, "slate/dark": 4.18 },
  },
  {
    pair: "subtle-foreground/surface",
    why: "Same tier as the pairing above, measured on cards and the Stepper.",
    measured: {
      "ember/light": 2.42,
      "ember/dark": 4.45,
      "ash/light": 4.16,
      "ash/dark": 4.45,
      "slate/light": 2.59,
      "slate/dark": 3.97,
    },
  },
  {
    pair: "primary/background",
    why: "Ember points `primary` at the identity-locked `--orange-300`, which cannot carry body text on a pale canvas at any lightness without moving the brand value. Ash already took the documented route — a deeper `--orange-550` for the action token while `brand` keeps the coral — and still lands just short here. Resolving Ember means splitting brand from action there too.",
    measured: { "ember/light": 3.0, "ash/light": 4.41 },
  },
  {
    pair: "primary/surface",
    why: "Same brand-pinned step as the pairing above; this is the one markdown links render against.",
    measured: { "ember/light": 3.25 },
  },
  {
    pair: "primary/surface-elevated",
    why: "Same brand-pinned step, measured in popovers.",
    measured: { "ember/light": 3.33 },
  },
  {
    pair: "primary-foreground/primary",
    why: "A white label on `--orange-300`. `color-primitives.md` records this step as clearing AA-large only, and pins its value to brand identity, so the label polarity or the action token has to move rather than the fill.",
    measured: { "ember/light": 3.33, "ember/dark": 3.33, "ash/dark": 3.33 },
  },
  {
    pair: "ring/primary",
    why: "Every theme points `ring` and `primary` at neighbouring steps of one ramp, and Slate points both at the same step, so the focus outline does not separate from a default Button's fill along its inner boundary. The outline sits outside the box, so its outer boundary against the canvas is what marks the control and a focused Button is not unmarked. Fixing it means giving the ring its own step rather than reusing the accent.",
    measured: {
      "ember/light": 1.08,
      "ember/dark": 1.08,
      "ash/light": 1.02,
      "ash/dark": 1.08,
      "slate/light": 1,
      "slate/dark": 1,
    },
  },
  {
    pair: "ring/secondary",
    why: "Same ring step against Ember's light secondary fill, which sits close enough to the accent to blunt the inner edge. The other five theme/modes clear the bar.",
    measured: { "ember/light": 2.9 },
  },
  {
    pair: "ring/input",
    why: "Same ring step against the unchecked Switch track in the two warm light themes. Slate clears it comfortably because its ring is ink rather than accent.",
    measured: { "ember/light": 2.91, "ash/light": 2.78 },
  },
];

// ─── Gate ─────────────────────────────────────────────────────────────────────

/** Resolves a semantic token to the literal its theme's palette holds. */
function resolveToken(theme: ThemeDefinition, mode: "light" | "dark", token: string): string {
  const declared = theme[mode][token];
  if (declared === undefined) {
    throw new Error(`${theme.id}.${mode} declares no token "${token}"`);
  }
  const reference = declared.match(/^var\(--([a-z0-9-]+)\)$/);
  if (!reference) return declared;

  const primitive = theme.palette[reference[1]];
  if (primitive === undefined) {
    throw new Error(`${theme.id}.${mode} "${token}" reads missing primitive "${reference[1]}"`);
  }
  return primitive;
}

const MODES = ["light", "dark"] as const;
const knownFailure = (pair: string, site: string) =>
  KNOWN_FAILURES.find((entry) => entry.pair === pair)?.measured[site];

/**
 * Every (theme, mode, pairing) the gate covers, measured once.
 *
 * `ratio` is the raw value and is what every bar comparison uses: rounding
 * first would let 4.499 pass AA and would mark a still-failing debt entry as
 * stale. `rounded` exists only to print, and to compare against the two-decimal
 * figures `KNOWN_FAILURES` records.
 */
const measurements = getThemeDefinitions().flatMap((theme) =>
  MODES.flatMap((mode) =>
    PAIRINGS.map((pairing) => {
      const pair = `${pairing.fg}/${pairing.bg}`;
      const ratio = contrastRatio(
        resolveToken(theme, mode, pairing.fg),
        resolveToken(theme, mode, pairing.bg),
      );
      return {
        site: `${theme.id}/${mode}`,
        pair,
        min: pairing.min,
        ratio,
        rounded: Math.round(ratio * 100) / 100,
        expected: knownFailure(pair, `${theme.id}/${mode}`),
      };
    }),
  ),
);

describe("theme contrast", () => {
  it("measures exactly the pinned roster, once per theme and mode", () => {
    // Compares against PAIRING_IDS rather than against PAIRINGS' own length,
    // which `measurements` is built from and so can never contradict. Dropping
    // a contract entry now fails here until the pinned list drops it too.
    expect(PAIRINGS.map((p) => `${p.fg}/${p.bg}`)).toEqual(PAIRING_IDS);
    expect(new Set(PAIRING_IDS).size).toBe(PAIRING_IDS.length);
    expect(measurements).toHaveLength(
      getThemeDefinitions().length * MODES.length * PAIRING_IDS.length,
    );
  });

  it("resolves every known failure against a pairing the roster measures", () => {
    // A debt record naming a pairing nobody measures is unfalsifiable — it
    // would sit in the table forever without the stale check ever reaching it.
    const orphaned = KNOWN_FAILURES.filter((entry) => !PAIRING_IDS.includes(entry.pair)).map(
      (entry) => entry.pair,
    );

    expect(orphaned).toEqual([]);
  });

  it("clears the WCAG bar for every pairing not recorded as a known failure", () => {
    const failing = measurements
      .filter((m) => m.expected === undefined && m.ratio < m.min)
      .map((m) => `${m.site} ${m.pair} — ${m.rounded}:1, needs ${m.min}:1`);

    expect(failing).toEqual([]);
  });

  it("still measures each known failure at the ratio it was recorded with", () => {
    // Two-sided on purpose. A pairing that improved past its bar means the
    // entry is stale and must be deleted, or the record stops describing what
    // ships; a pairing that got worse is a regression the bar alone can't see,
    // because it was already below it. Compared at the recorded precision.
    const drifted = measurements
      .filter((m) => m.expected !== undefined && m.rounded !== m.expected)
      .map((m) => `${m.site} ${m.pair} — recorded ${m.expected}:1, now ${m.rounded}:1`);

    expect(drifted).toEqual([]);
  });

  it("records no known failure that has stopped failing", () => {
    const stale = KNOWN_FAILURES.flatMap((entry) =>
      Object.keys(entry.measured)
        .filter((site) => {
          const measured = measurements.find((m) => m.site === site && m.pair === entry.pair);
          return measured === undefined || measured.ratio >= measured.min;
        })
        .map((site) => `${site} ${entry.pair}`),
    );

    expect(stale).toEqual([]);
  });

  it("points every known failure at a tracked issue", () => {
    expect(KNOWN_FAILURE_ISSUE).toMatch(/^https:\/\/github\.com\/\S+\/issues\/\d+$/);
    for (const entry of KNOWN_FAILURES) {
      expect({ pair: entry.pair, explained: entry.why.length > 40 }).toEqual({
        pair: entry.pair,
        explained: true,
      });
    }
  });
});

describe("contrast math", () => {
  // The gate is only worth its verdicts if the ratio it computes is the one
  // WCAG defines, so pin the two ends of the scale and a published mid-value.
  it("puts black on white at 21:1 and a color on itself at 1:1", () => {
    expect(contrastRatio("#000000", "#ffffff")).toBeCloseTo(21, 2);
    expect(contrastRatio("#3b82f6", "#3b82f6")).toBeCloseTo(1, 5);
  });

  it("is symmetric in its arguments", () => {
    expect(contrastRatio("#767676", "#ffffff")).toBeCloseTo(contrastRatio("#ffffff", "#767676"), 6);
  });

  it("agrees with the published ratio for the AA reference grey", () => {
    // #767676 on white is the canonical 4.54:1 example — the darkest grey that
    // clears AA against white.
    expect(contrastRatio("#767676", "#ffffff")).toBeCloseTo(4.54, 2);
  });

  it("reads oklch and hex forms of the same color alike", () => {
    // Both syntaxes appear in the palettes, and a parser that handled only one
    // would silently skip whole ramps.
    expect(contrastRatio("oklch(1 0 0)", "#000000")).toBeCloseTo(21, 1);
  });

  it("refuses a palette value it cannot read", () => {
    expect(() => contrastRatio("rebeccapurple", "#ffffff")).toThrow(/neither/);
  });
});
