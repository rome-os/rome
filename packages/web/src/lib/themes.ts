/**
 * Theme definitions — the single source of truth for the dashboard's palettes.
 *
 * A theme carries two things:
 *
 *   - `palette` — a value for every primitive in the canonical scale. The scale
 *     is a fixed set of names (`--neutral-500`, `--red-400`, `--orange-300`);
 *     every theme defines all of them and gives them its own values. Nothing is
 *     shared at runtime: switching theme swaps the values the names hold.
 *   - `light` / `dark` — which primitive each semantic token reads. A theme
 *     picks its own steps, which is how Ember points `--info` at its orange
 *     while Slate points at its blue without either primitive name lying about
 *     the color it holds.
 *
 * `buildThemeCss` (lib/theme.ts) emits the palette plus resolved light values
 * into `[data-theme="<id>"]`, and resolved dark values into
 * `[data-theme="<id>"].dark`. The palette spans both modes — a step number
 * tracks lightness across the whole range — so only the mapping has halves.
 *
 * Palette values are literals (or self-contained expressions such as
 * `color-mix(...)` and shadow lists); source mapping values are
 * `var(--<primitive>)`. The generator substitutes the theme's palette literal
 * into each emitted semantic value. Neither layer inlines a raw color into a
 * component.
 *
 * The scale — every primitive name and why the values are what they are — is
 * documented in `docs/ui/primitive-token/color-primitives.md`.
 *
 * To add a theme, append a definition here. Nothing else changes: the picker,
 * the CSS injection, and the no-flash bootstrap are all data-driven.
 *
 * B-ready seam: `getThemeDefinitions()` in lib/theme.ts returns this array
 * today. When themes become backend-served, that function merges fetched
 * definitions of this exact shape — the generator and injector are unchanged.
 */

/** A primitive-token → value map: one theme's whole palette. Keys are primitive
 *  names without the `--` prefix; values are literals or self-contained
 *  expressions. */
export type Palette = Record<string, string>;

/** A semantic-token → source value map. Keys omit the `--` prefix; values
 *  reference a primitive (`var(--neutral-50)`) or are self-contained expressions
 *  (`color-mix(...)`, shadow lists). `buildThemeCss` resolves the references. */
export type ThemeTokens = Record<string, string>;

export type ThemeDefinition = {
  id: string;
  label: string;
  /** Every primitive on the scale, valued for this theme. Spans both modes. */
  palette: Palette;
  /** Light mapping — applied under `[data-theme="<id>"]`. */
  light: ThemeTokens;
  /** Dark mapping — applied under `[data-theme="<id>"].dark`. */
  dark: ThemeTokens;
};

/** Elevation scale — four mode-halved steps, spread into every mapping half.
 *  The dark half deepens the ink and widens the blur: a black-at-10% cast
 *  vanishes on dark surfaces. A step's number is its light-half y-offset. The
 *  scale and the rationale for each value:
 *  `docs/ui/primitive-token/elevation-primitives.md`. */
const SHADOWS_LIGHT = {
  "rome-shadow-1": "0 1px 3px 0 rgb(0 0 0 / 0.1), 0 1px 2px -1px rgb(0 0 0 / 0.1)",
  "rome-shadow-4": "0 4px 6px -1px rgb(0 0 0 / 0.1), 0 2px 4px -2px rgb(0 0 0 / 0.1)",
  "rome-shadow-10": "0 10px 15px -3px rgb(0 0 0 / 0.1), 0 4px 6px -4px rgb(0 0 0 / 0.1)",
  "rome-shadow-25": "0 25px 50px -12px rgb(0 0 0 / 0.25)",
} satisfies ThemeTokens;
const SHADOWS_DARK = {
  "rome-shadow-1": "0 1px 3px 0 rgb(0 0 0 / 0.45), 0 1px 2px -1px rgb(0 0 0 / 0.4)",
  "rome-shadow-4": "0 6px 16px -2px rgb(0 0 0 / 0.55), 0 2px 6px -2px rgb(0 0 0 / 0.5)",
  "rome-shadow-10": "0 12px 28px -4px rgb(0 0 0 / 0.6), 0 4px 10px -4px rgb(0 0 0 / 0.5)",
  "rome-shadow-25": "0 25px 60px -12px rgb(0 0 0 / 0.7)",
} satisfies ThemeTokens;

/** Deprecated status label tokens, kept as host declarations only.
 *
 *  An app is installed as a built artifact: its CSS was compiled against
 *  whatever the host declared that day, and it inherits these names at mount
 *  rather than carrying values for them. Dropping a name from the host is
 *  therefore not a source-level break a major version covers — an artifact
 *  built before the merge keeps asking for `--brand-foreground`, and an
 *  unstyled label is all it gets back.
 *
 *  So the names outlive their removal from the vocabulary. They hold the value
 *  they held before `-fg` became the family's only foreground, they are absent
 *  from the `@theme inline` map in `@rome-os/ui`, and Tailwind emits no utility
 *  for them — nothing new can reach them, and nothing already built breaks.
 *  They leave once no installed artifact references them.
 *
 *  A theme half spreads the set matching its own neutrals. */
const LEGACY_STATUS_LABELS_WARM_LIGHT = {
  "brand-foreground": "var(--neutral-0)",
  "destructive-foreground": "var(--neutral-0)",
  "success-foreground": "var(--neutral-0)",
  "warning-foreground": "var(--neutral-850)",
  "info-foreground": "var(--neutral-0)",
} satisfies ThemeTokens;
const LEGACY_STATUS_LABELS_WARM_DARK = {
  "brand-foreground": "var(--neutral-0)",
  "destructive-foreground": "var(--neutral-50)",
  "success-foreground": "var(--neutral-950)",
  "warning-foreground": "var(--neutral-900)",
  "info-foreground": "var(--neutral-50)",
} satisfies ThemeTokens;
const LEGACY_STATUS_LABELS_SLATE_LIGHT = {
  "brand-foreground": "var(--neutral-50)",
  "destructive-foreground": "var(--neutral-50)",
  "success-foreground": "var(--neutral-50)",
  "warning-foreground": "var(--neutral-850)",
  "info-foreground": "var(--neutral-50)",
} satisfies ThemeTokens;
const LEGACY_STATUS_LABELS_SLATE_DARK = {
  "brand-foreground": "var(--neutral-950)",
  "destructive-foreground": "var(--neutral-50)",
  "success-foreground": "var(--neutral-950)",
  "warning-foreground": "var(--neutral-900)",
  "info-foreground": "var(--neutral-950)",
} satisfies ThemeTokens;

// ─── Chromatic ramps ──────────────────────────────────────────────────────────
// A theme that has no opinion about a hue still carries it — the scale is the
// same set of names under every theme, so any semantic token can be re-pointed
// without adding a primitive. Sharing a constant here is authoring convenience;
// each theme still emits its own copy, and overriding one is a value edit.

const RED: Palette = {
  "red-50": "oklch(0.97 0.04 27)",
  "red-100": "oklch(0.94 0.06 27)",
  "red-200": "oklch(0.86 0.08 27)",
  "red-250": "oklch(0.85 0.13 27)",
  "red-300": "oklch(0.7 0.2 27)",
  "red-400": "oklch(0.58 0.245 27)",
  "red-500": "oklch(0.45 0.18 27)",
  "red-600": "oklch(0.4 0.12 27)",
  "red-700": "oklch(0.32 0.09 27)",
  "red-800": "oklch(0.27 0.07 27)",
};

const AMBER: Palette = {
  "amber-50": "oklch(0.97 0.05 80)",
  "amber-100": "oklch(0.94 0.07 80)",
  "amber-150": "oklch(0.88 0.12 80)",
  "amber-200": "oklch(0.86 0.09 80)",
  "amber-300": "oklch(0.82 0.14 80)",
  "amber-400": "oklch(0.78 0.15 80)",
  "amber-500": "oklch(0.45 0.11 80)",
  "amber-600": "oklch(0.36 0.09 80)",
  "amber-700": "oklch(0.3 0.07 80)",
};

const BLUE: Palette = {
  "blue-50": "oklch(0.97 0.04 250)",
  "blue-100": "oklch(0.86 0.08 250)",
  "blue-150": "oklch(0.85 0.13 250)",
  "blue-200": "oklch(0.7 0.17 250)",
  "blue-300": "oklch(0.62 0.18 250)",
  "blue-500": "oklch(0.45 0.16 250)",
  "blue-600": "oklch(0.42 0.11 250)",
  "blue-700": "oklch(0.28 0.06 250)",
};

/** A cool green at hue 150 — Slate's, and the deep end of Ember's and Ash's. */
const GREEN_COOL: Palette = {
  "green-50": "oklch(0.97 0.05 150)",
  "green-100": "oklch(0.86 0.09 150)",
  "green-150": "oklch(0.85 0.13 150)",
  "green-200": "oklch(0.72 0.16 150)",
  "green-300": "oklch(0.65 0.17 150)",
  "green-500": "oklch(0.45 0.13 150)",
  "green-600": "oklch(0.4 0.1 150)",
  "green-700": "oklch(0.27 0.06 150)",
};

/** Ember's and Ash's green. The pale end is warm, so a confirmation on a warm
 *  canvas doesn't read as a cool foreign chip; the deep end stays at hue 150,
 *  which is why the light and dark mappings pick from opposite halves. Steps 100
 *  and 150 sit .02 apart in lightness and swap places against the cool ramp —
 *  a theme's mapping picks the step, so both ramps stay ordered. */
const GREEN_WARM: Palette = {
  "green-50": "#e4ead5",
  "green-100": "oklch(0.85 0.13 150)",
  "green-150": "#c5d2b5",
  "green-200": "oklch(0.72 0.16 150)",
  "green-300": "#5b7a4a",
  "green-500": "#44603a",
  "green-600": "oklch(0.4 0.1 150)",
  "green-700": "oklch(0.27 0.06 150)",
};

/** The ember family. Steps 500–600 span .04 lightness and differ mainly in
 *  chroma — they are the deeper variants Ash needs to clear AA against its
 *  lighter surfaces, not three visibly different depths. */
const ORANGE: Palette = {
  "orange-50": "#ffead9",
  "orange-100": "#fbcda6",
  "orange-200": "#f4a268",
  "orange-300": "#d86f4c",
  "orange-400": "#e55a22",
  "orange-500": "#d1490f",
  "orange-550": "#c05433",
  "orange-600": "#c2410c",
  "orange-700": "#b0421a",
  "orange-800": "#a63a08",
  "orange-900": "oklch(0.27 0.05 45)",
};

// ─── Ember ────────────────────────────────────────────────────────────────────

/** Ember (default) — warm-linen canvas, warm-paper cards, a coral accent, and
 *  warm ember standing in for the informational blue. Its neutral runs warm the
 *  whole way: hand-authored hex through the light half, then OKLCH at hue 55 and
 *  chroma ≤ .009 through the dark half, so the dark canvas reads as warm
 *  charcoal rather than coffee-brown, and its depth still lines up with Slate's.
 *
 *  Steps 250, 350 and 400 are interpolated between their neighbours: no Ember
 *  mapping reads them, but Ash and Slate distinguish depths there, and the scale
 *  is the same set of names under every theme. */
const emberPalette: Palette = {
  "neutral-0": "#ffffff",
  "neutral-25": "#fdfcf9",
  "neutral-50": "#f4f3ef",
  "neutral-100": "#efe9e1",
  "neutral-150": "#ece6de",
  "neutral-200": "#eae6df",
  "neutral-250": "#e5dfd6",
  "neutral-300": "#e0d8cd",
  "neutral-350": "#d0c6ba",
  "neutral-400": "#c0b4a7",
  "neutral-450": "#b0a294",
  "neutral-500": "#8a7868",
  "neutral-550": "#7a6857",
  "neutral-600": "#6f5c50",
  "neutral-650": "oklch(0.4 0.009 55)",
  "neutral-700": "oklch(0.32 0.009 55)",
  "neutral-750": "oklch(0.27 0.009 55)",
  "neutral-800": "#2a211b",
  "neutral-850": "oklch(0.215 0.008 55)",
  "neutral-900": "#1a130f",
  "neutral-925": "oklch(0.18 0.007 55)",
  "neutral-950": "oklch(0.14 0.005 55)",
  ...RED,
  ...GREEN_WARM,
  ...AMBER,
  ...BLUE,
  ...ORANGE,
};

const ember: ThemeDefinition = {
  id: "ember",
  label: "Ember",
  palette: emberPalette,
  light: {
    background: "var(--neutral-50)",
    "chat-canvas": "var(--neutral-50)",
    "app-canvas": "var(--neutral-25)",
    foreground: "var(--neutral-900)",

    surface: "var(--neutral-25)",
    "surface-foreground": "var(--neutral-900)",
    "surface-muted": "var(--neutral-100)",
    "surface-muted-foreground": "var(--neutral-600)",
    "surface-elevated": "var(--neutral-0)",
    "surface-hover": "var(--neutral-200)",

    // Muted body text sits at 5.2:1 on `--surface` here. A lighter step drops
    // CardDescription and DialogDescription under the 4.5:1 AA bar.
    "muted-foreground": "var(--neutral-550)",
    "subtle-foreground": "var(--neutral-450)",

    border: "var(--neutral-150)",
    "border-strong": "var(--neutral-300)",
    "border-subtle": "var(--neutral-100)",

    ...SHADOWS_LIGHT,
    "rome-shadow-card-hover": SHADOWS_LIGHT["rome-shadow-4"],

    ring: "var(--orange-400)",
    input: "var(--neutral-150)",

    primary: "var(--orange-300)",
    "primary-foreground": "var(--neutral-0)",
    "primary-hover": "var(--orange-600)",

    brand: "var(--orange-300)",
    "brand-fg": "var(--neutral-900)",

    overlay: "color-mix(in srgb, var(--neutral-900) 45%, transparent)",

    secondary: "var(--neutral-200)",
    "secondary-foreground": "var(--neutral-900)",
    muted: "var(--neutral-100)",
    accent: "var(--neutral-200)",
    "accent-foreground": "var(--neutral-900)",

    destructive: "var(--red-400)",
    "destructive-bg": "var(--red-50)",
    "destructive-fg": "var(--red-500)",
    "destructive-border": "var(--red-200)",
    "destructive-hover-bg": "var(--red-100)",

    success: "var(--green-300)",
    "success-bg": "var(--green-50)",
    "success-fg": "var(--green-500)",
    "success-border": "var(--green-150)",

    warning: "var(--amber-400)",
    "warning-bg": "var(--amber-50)",
    "warning-fg": "var(--amber-500)",
    "warning-border": "var(--amber-200)",
    "warning-hover-bg": "var(--amber-100)",

    // Info reads the ember ramp, not the blue one — the Ember palette has no
    // blue in play. At 5.0:1 on `--info-bg` `info-fg` carries the alert title;
    // a lighter step drops it under AA.
    info: "var(--orange-400)",
    "info-bg": "var(--orange-50)",
    "info-fg": "var(--orange-700)",
    "info-border": "var(--orange-100)",

    ...LEGACY_STATUS_LABELS_WARM_LIGHT,
  },
  dark: {
    background: "var(--neutral-950)",
    "chat-canvas": "var(--neutral-950)",
    "app-canvas": "var(--neutral-950)",
    foreground: "var(--neutral-50)",

    surface: "var(--neutral-925)",
    "surface-foreground": "var(--neutral-50)",
    "surface-muted": "var(--neutral-850)",
    "surface-muted-foreground": "var(--neutral-450)",
    "surface-elevated": "var(--neutral-850)",
    "surface-hover": "var(--neutral-750)",

    "muted-foreground": "var(--neutral-450)",
    "subtle-foreground": "var(--neutral-500)",

    ...SHADOWS_DARK,
    "rome-shadow-card-hover": SHADOWS_DARK["rome-shadow-4"],

    border: "var(--neutral-700)",
    "border-strong": "var(--neutral-650)",
    "border-subtle": "var(--neutral-850)",

    ring: "var(--orange-400)",
    input: "var(--neutral-700)",

    primary: "var(--orange-300)",
    "primary-foreground": "var(--neutral-0)",
    "primary-hover": "var(--orange-600)",

    brand: "var(--orange-300)",
    "brand-fg": "var(--neutral-950)",

    overlay: "color-mix(in srgb, black 60%, transparent)",

    secondary: "var(--neutral-750)",
    "secondary-foreground": "var(--neutral-50)",
    muted: "var(--neutral-850)",
    accent: "var(--neutral-750)",
    "accent-foreground": "var(--neutral-50)",

    destructive: "var(--red-300)",
    "destructive-bg": "var(--red-800)",
    "destructive-fg": "var(--red-250)",
    "destructive-border": "var(--red-600)",
    "destructive-hover-bg": "var(--red-700)",

    success: "var(--green-200)",
    "success-bg": "var(--green-700)",
    "success-fg": "var(--green-100)",
    "success-border": "var(--green-600)",

    warning: "var(--amber-300)",
    "warning-bg": "var(--amber-700)",
    "warning-fg": "var(--amber-150)",
    "warning-border": "var(--amber-500)",
    "warning-hover-bg": "var(--amber-600)",

    // The dark info chip is an ember-tinted dim surface with glow text — the
    // only saturated callout on the canvas, so a note reads as "lit ember"
    // rather than a generic blue notification.
    info: "var(--orange-400)",
    "info-bg": "var(--orange-900)",
    "info-fg": "var(--orange-200)",
    "info-border": "var(--orange-600)",

    ...LEGACY_STATUS_LABELS_WARM_DARK,
  },
};

// ─── Ash ──────────────────────────────────────────────────────────────────────

/** Ash — Ember cooled. Its neutral desaturates Ember's at constant lightness
 *  through the light half (red minus blue held under 10, against up to 33 on
 *  Ember's) so nothing large carries a yellow cast, while the ink steps stay
 *  warm — warmth in text and highlights reads as character, warmth across a
 *  full-page canvas reads as a tint. The dark half is Ember's verbatim: those
 *  steps already sit at chroma ≤ .009, so there is no yellow there to remove.
 *
 *  Because the surfaces lightened, the mapping reaches for deeper accent steps
 *  to hold contrast: `primary` is `--orange-550` (white label 4.6:1, against
 *  3.3:1 on the step Ember uses), the link is `--orange-700` at 5.7:1, and muted
 *  text is `--neutral-550` at 5.2:1. Don't re-point those at lighter steps
 *  without re-measuring — they are why this theme clears AA where Ember doesn't.
 *  `brand` stays on Ember's step: only the interactive accent deepened, so logo
 *  and marketing marks stay on-brand across themes. */
const ashPalette: Palette = {
  "neutral-0": "#ffffff",
  "neutral-25": "#fefdfb",
  "neutral-50": "#fbfaf7",
  "neutral-100": "#f8f7f4",
  "neutral-150": "#f5f4f1",
  "neutral-200": "#e7e5e2",
  "neutral-250": "#dfddd9",
  "neutral-300": "#d6d4d0",
  "neutral-350": "#cecbc7",
  "neutral-400": "#bcb8b3",
  "neutral-450": "#b0a294",
  "neutral-500": "#8a7868",
  "neutral-550": "#7a6857",
  "neutral-600": "#6f5c50",
  "neutral-650": "oklch(0.4 0.009 55)",
  "neutral-700": "oklch(0.32 0.009 55)",
  "neutral-750": "oklch(0.27 0.009 55)",
  "neutral-800": "#2a211b",
  "neutral-850": "oklch(0.215 0.008 55)",
  "neutral-900": "#1a130f",
  "neutral-925": "oklch(0.18 0.007 55)",
  "neutral-950": "oklch(0.14 0.005 55)",
  ...RED,
  ...GREEN_WARM,
  ...AMBER,
  ...BLUE,
  ...ORANGE,
};

const ash: ThemeDefinition = {
  id: "ash",
  label: "Ash",
  palette: ashPalette,
  light: {
    background: "var(--neutral-50)",
    "chat-canvas": "var(--neutral-50)",
    "app-canvas": "var(--neutral-25)",
    foreground: "var(--neutral-900)",

    surface: "var(--neutral-25)",
    "surface-foreground": "var(--neutral-900)",
    "surface-muted": "var(--neutral-150)",
    "surface-muted-foreground": "var(--neutral-600)",
    "surface-elevated": "var(--neutral-0)",
    "surface-hover": "var(--neutral-100)",

    "muted-foreground": "var(--neutral-550)",
    "subtle-foreground": "var(--neutral-500)",

    border: "var(--neutral-300)",
    "border-strong": "var(--neutral-400)",
    "border-subtle": "var(--neutral-200)",

    ...SHADOWS_LIGHT,
    "rome-shadow-card-hover": SHADOWS_LIGHT["rome-shadow-4"],

    ring: "var(--orange-500)",
    // Field edge sits one step darker than the dividers, on purpose: a control
    // should read as a control before you focus it.
    input: "var(--neutral-350)",

    primary: "var(--orange-550)",
    "primary-foreground": "var(--neutral-0)",
    "primary-hover": "var(--orange-800)",

    brand: "var(--orange-300)",
    "brand-fg": "var(--neutral-900)",

    overlay: "color-mix(in srgb, var(--neutral-900) 45%, transparent)",

    secondary: "var(--neutral-150)",
    "secondary-foreground": "var(--neutral-900)",
    muted: "var(--neutral-150)",
    accent: "var(--neutral-100)",
    "accent-foreground": "var(--neutral-900)",

    destructive: "var(--red-400)",
    "destructive-bg": "var(--red-50)",
    "destructive-fg": "var(--red-500)",
    "destructive-border": "var(--red-200)",
    "destructive-hover-bg": "var(--red-100)",

    success: "var(--green-300)",
    "success-bg": "var(--green-50)",
    "success-fg": "var(--green-500)",
    "success-border": "var(--green-150)",

    warning: "var(--amber-400)",
    "warning-bg": "var(--amber-50)",
    "warning-fg": "var(--amber-500)",
    "warning-border": "var(--amber-200)",
    "warning-hover-bg": "var(--amber-100)",

    // Info reads the ember ramp here too.
    info: "var(--orange-500)",
    "info-bg": "var(--orange-50)",
    "info-fg": "var(--orange-700)",
    "info-border": "var(--orange-100)",

    ...LEGACY_STATUS_LABELS_WARM_LIGHT,
  },
  // Spread rather than copied: the two dark mappings are meant to stay
  // identical, so a future Ember dark change should land here too instead of
  // silently leaving Ash behind.
  //
  // It resolves against Ash's palette, not Ember's, so the two dark halves are
  // no longer pixel-identical: every step from 450 down is shared, but the ink
  // reads `--neutral-50`, and Ash's is its own cooler near-white (.985 against
  // Ember's .964). That is the theme being consistent with itself — Ash is
  // Ember cooled, in both modes — rather than borrowing Ember's swatch.
  dark: { ...ember.dark },
};

// ─── Slate ────────────────────────────────────────────────────────────────────

/** Slate — cool grey canvas, white cards, ink accent, blue info. Modeled after
 *  shadcn's neutral preset: `primary`, `brand` and the focus ring all read the
 *  ink end of the neutral ramp, which is also why Slate is the one theme whose
 *  accent inverts between modes. Its orange ramp is Ember's, carried but unread.
 *
 *  Steps 25, 150, 350, 450, 550 and 925 are interpolated between their
 *  neighbours: no Slate mapping reads them, but Ember and Ash distinguish depths
 *  there, and the scale is the same set of names under every theme. */
const slatePalette: Palette = {
  "neutral-0": "oklch(1 0 0)",
  "neutral-25": "oklch(0.992 0 0)",
  "neutral-50": "oklch(0.985 0 0)",
  "neutral-100": "oklch(0.97 0 0)",
  "neutral-150": "oklch(0.945 0 0)",
  "neutral-200": "oklch(0.92 0 0)",
  "neutral-250": "oklch(0.9 0 0)",
  "neutral-300": "oklch(0.83 0 0)",
  "neutral-350": "oklch(0.769 0 0)",
  "neutral-400": "oklch(0.708 0 0)",
  "neutral-450": "oklch(0.632 0 0)",
  "neutral-500": "oklch(0.556 0 0)",
  "neutral-550": "oklch(0.493 0 0)",
  "neutral-600": "oklch(0.43 0 0)",
  "neutral-650": "oklch(0.4 0 0)",
  "neutral-700": "oklch(0.3 0 0)",
  "neutral-750": "oklch(0.265 0 0)",
  "neutral-800": "oklch(0.24 0 0)",
  "neutral-850": "oklch(0.21 0 0)",
  "neutral-900": "oklch(0.18 0 0)",
  "neutral-925": "oklch(0.163 0 0)",
  "neutral-950": "oklch(0.145 0 0)",
  ...RED,
  ...GREEN_COOL,
  ...AMBER,
  ...BLUE,
  ...ORANGE,
};

const slate: ThemeDefinition = {
  id: "slate",
  label: "Slate",
  palette: slatePalette,
  light: {
    background: "var(--neutral-50)",
    "chat-canvas": "var(--neutral-50)",
    "app-canvas": "var(--neutral-0)",
    foreground: "var(--neutral-950)",

    surface: "var(--neutral-0)",
    "surface-foreground": "var(--neutral-950)",
    "surface-muted": "var(--neutral-100)",
    "surface-muted-foreground": "var(--neutral-600)",
    "surface-elevated": "var(--neutral-0)",
    "surface-hover": "var(--neutral-100)",

    "muted-foreground": "var(--neutral-500)",
    "subtle-foreground": "var(--neutral-400)",

    border: "var(--neutral-200)",
    "border-strong": "var(--neutral-300)",
    "border-subtle": "var(--neutral-100)",

    ...SHADOWS_LIGHT,
    "rome-shadow-card-hover": SHADOWS_LIGHT["rome-shadow-4"],

    ring: "var(--neutral-900)",
    input: "var(--neutral-200)",

    primary: "var(--neutral-900)",
    "primary-foreground": "var(--neutral-50)",
    "primary-hover": "var(--neutral-800)",

    brand: "var(--neutral-900)",
    "brand-fg": "var(--neutral-50)",

    overlay: "color-mix(in srgb, var(--neutral-950) 45%, transparent)",

    secondary: "var(--neutral-200)",
    "secondary-foreground": "var(--neutral-900)",
    muted: "var(--neutral-100)",
    accent: "var(--neutral-200)",
    "accent-foreground": "var(--neutral-900)",

    destructive: "var(--red-400)",
    "destructive-bg": "var(--red-50)",
    "destructive-fg": "var(--red-500)",
    "destructive-border": "var(--red-200)",
    "destructive-hover-bg": "var(--red-100)",

    success: "var(--green-300)",
    "success-bg": "var(--green-50)",
    "success-fg": "var(--green-500)",
    "success-border": "var(--green-100)",

    warning: "var(--amber-400)",
    "warning-bg": "var(--amber-50)",
    "warning-fg": "var(--amber-500)",
    "warning-border": "var(--amber-200)",
    "warning-hover-bg": "var(--amber-100)",

    info: "var(--blue-300)",
    "info-bg": "var(--blue-50)",
    "info-fg": "var(--blue-500)",
    "info-border": "var(--blue-100)",

    ...LEGACY_STATUS_LABELS_SLATE_LIGHT,
  },
  dark: {
    background: "var(--neutral-950)",
    "chat-canvas": "var(--neutral-950)",
    "app-canvas": "var(--neutral-950)",
    foreground: "var(--neutral-50)",

    surface: "var(--neutral-900)",
    "surface-foreground": "var(--neutral-50)",
    "surface-muted": "var(--neutral-850)",
    "surface-muted-foreground": "var(--neutral-400)",
    "surface-elevated": "var(--neutral-850)",
    "surface-hover": "var(--neutral-750)",

    "muted-foreground": "var(--neutral-400)",
    "subtle-foreground": "var(--neutral-500)",

    ...SHADOWS_DARK,
    "rome-shadow-card-hover": SHADOWS_DARK["rome-shadow-4"],

    border: "var(--neutral-700)",
    "border-strong": "var(--neutral-650)",
    "border-subtle": "var(--neutral-800)",

    ring: "var(--neutral-50)",
    input: "var(--neutral-700)",

    primary: "var(--neutral-50)",
    "primary-foreground": "var(--neutral-950)",
    "primary-hover": "var(--neutral-250)",

    brand: "var(--neutral-50)",
    "brand-fg": "var(--neutral-950)",

    overlay: "color-mix(in srgb, black 60%, transparent)",

    secondary: "var(--neutral-750)",
    "secondary-foreground": "var(--neutral-50)",
    muted: "var(--neutral-750)",
    accent: "var(--neutral-750)",
    "accent-foreground": "var(--neutral-50)",

    destructive: "var(--red-300)",
    "destructive-bg": "var(--red-800)",
    "destructive-fg": "var(--red-250)",
    "destructive-border": "var(--red-600)",
    "destructive-hover-bg": "var(--red-700)",

    success: "var(--green-200)",
    "success-bg": "var(--green-700)",
    "success-fg": "var(--green-150)",
    "success-border": "var(--green-600)",

    warning: "var(--amber-300)",
    "warning-bg": "var(--amber-700)",
    "warning-fg": "var(--amber-150)",
    "warning-border": "var(--amber-500)",
    "warning-hover-bg": "var(--amber-600)",

    info: "var(--blue-200)",
    "info-bg": "var(--blue-700)",
    "info-fg": "var(--blue-150)",
    "info-border": "var(--blue-600)",

    ...LEGACY_STATUS_LABELS_SLATE_DARK,
  },
};

/** The themes compiled into the bundle. Order is presentation order in the
 *  picker. The first entry is the default (see DEFAULT_THEME_NAME). */
export const BUILTIN_THEMES: ThemeDefinition[] = [ember, ash, slate];
