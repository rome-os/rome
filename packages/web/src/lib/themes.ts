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

/** The pastel themes' green. Slate's cool green with step 300 a hair deeper:
 *  the sidebar's upgrade disc is `--success` under a `--surface` glyph, and on a
 *  hue-tinted card the lighter step lands just under the 3:1 non-text bar. */
const GREEN_FRESH: Palette = {
  ...GREEN_COOL,
  "green-300": "oklch(0.63 0.17 150)",
};

/** The same ramp rotated to a yellow-leaning hue 135 — Mint's, so a
 *  confirmation does not read as the mint brand beside it. */
const GREEN_GRASS: Palette = {
  "green-50": "oklch(0.97 0.05 135)",
  "green-100": "oklch(0.86 0.09 135)",
  "green-150": "oklch(0.85 0.13 135)",
  "green-200": "oklch(0.72 0.16 135)",
  "green-300": "oklch(0.63 0.17 135)",
  "green-500": "oklch(0.45 0.13 135)",
  "green-600": "oklch(0.4 0.1 135)",
  "green-700": "oklch(0.27 0.06 135)",
};

/** Blue rotated toward indigo (hue 270) — Sky's, so the informational blue
 *  stays apart from the sky-blue brand. Same lightness and chroma steps. */
const BLUE_INDIGO: Palette = {
  "blue-50": "oklch(0.97 0.04 270)",
  "blue-100": "oklch(0.86 0.08 270)",
  "blue-150": "oklch(0.85 0.13 270)",
  "blue-200": "oklch(0.7 0.17 270)",
  "blue-300": "oklch(0.62 0.18 270)",
  "blue-500": "oklch(0.45 0.16 270)",
  "blue-600": "oklch(0.42 0.11 270)",
  "blue-700": "oklch(0.28 0.06 270)",
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

// ─── Accent ramps ─────────────────────────────────────────────────────────────
// One ramp per accent hue, on the same step set and lightness ladder as
// `--orange-*`. The four pastel themes each read one of them (`pastelLight` and
// `pastelDark` below). Every theme carries all four, per the rule above, so a
// theme that wants a different accent re-points a mapping and adds nothing.
// Steps 50 and 100 are pale fills, 300 is the soft brand tone, 550 is the
// white-label step, 800 is the deep ring, and 200 and 500 serve the dark half.

/** Sky blue, hue 242 — cooler and softer than `--blue-*`, which stays the
 *  informational blue. */
const SKY: Palette = {
  "sky-50": "oklch(0.975 0.006 242)",
  "sky-100": "oklch(0.948 0.016 242)",
  "sky-200": "oklch(0.875 0.066 242)",
  "sky-300": "oklch(0.78 0.085 242)",
  "sky-400": "oklch(0.68 0.08 242)",
  "sky-500": "oklch(0.57 0.096 242)",
  "sky-550": "oklch(0.55 0.084 242)",
  "sky-600": "oklch(0.5 0.08 242)",
  "sky-700": "oklch(0.45 0.076 242)",
  "sky-800": "oklch(0.26 0.052 242)",
  "sky-900": "oklch(0.2 0.032 242)",
};

/** Teal, hue 174 — a seafoam-sage at low chroma. Step 550 sits .01 lower than the
 *  other accents: a green-teal clears AA for a white label at lower lightness. */
const TEAL: Palette = {
  "teal-50": "oklch(0.975 0.006 174)",
  "teal-100": "oklch(0.948 0.016 174)",
  "teal-200": "oklch(0.875 0.075 174)",
  "teal-300": "oklch(0.78 0.075 174)",
  "teal-400": "oklch(0.68 0.064 174)",
  "teal-500": "oklch(0.57 0.0768 174)",
  "teal-550": "oklch(0.54 0.0672 174)",
  "teal-600": "oklch(0.5 0.064 174)",
  "teal-700": "oklch(0.45 0.0608 174)",
  "teal-800": "oklch(0.26 0.0416 174)",
  "teal-900": "oklch(0.2 0.0256 174)",
};

/** Violet, hue 286 — a quiet blue-violet. */
const VIOLET: Palette = {
  "violet-50": "oklch(0.975 0.006 286)",
  "violet-100": "oklch(0.948 0.016 286)",
  "violet-200": "oklch(0.895 0.052 286)",
  "violet-300": "oklch(0.78 0.1 286)",
  "violet-400": "oklch(0.68 0.095 286)",
  "violet-500": "oklch(0.59 0.114 286)",
  "violet-550": "oklch(0.55 0.0997 286)",
  "violet-600": "oklch(0.5 0.095 286)",
  "violet-700": "oklch(0.45 0.0902 286)",
  "violet-800": "oklch(0.26 0.0617 286)",
  "violet-900": "oklch(0.2 0.038 286)",
};

/** Pink, hue 352 — a dusty mauve-rose that leans blue, well away from `--red-*`
 *  (hue 27). */
const PINK: Palette = {
  "pink-50": "oklch(0.975 0.006 352)",
  "pink-100": "oklch(0.948 0.016 352)",
  "pink-200": "oklch(0.895 0.062 352)",
  "pink-300": "oklch(0.78 0.09 352)",
  "pink-400": "oklch(0.68 0.082 352)",
  "pink-500": "oklch(0.59 0.0984 352)",
  "pink-550": "oklch(0.55 0.0861 352)",
  "pink-600": "oklch(0.5 0.082 352)",
  "pink-700": "oklch(0.45 0.0779 352)",
  "pink-800": "oklch(0.26 0.0533 352)",
  "pink-900": "oklch(0.2 0.0328 352)",
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
  ...SKY,
  ...TEAL,
  ...VIOLET,
  ...PINK,
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

    // The sidebar's running spinner. Blue in every theme, to match the tab
    // badge; `info` is orange under Ember and Ash. Apps receive the variable
    // with the theme, but it is not in the app token contract.
    running: "var(--blue-300)",

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

    running: "var(--blue-200)",

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
  ...SKY,
  ...TEAL,
  ...VIOLET,
  ...PINK,
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

    running: "var(--blue-300)",

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
  ...SKY,
  ...TEAL,
  ...VIOLET,
  ...PINK,
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

    running: "var(--blue-300)",

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

    running: "var(--blue-200)",

    ...LEGACY_STATUS_LABELS_SLATE_DARK,
  },
};

// ─── Pastel themes ────────────────────────────────────────────────────────────
// Sky, Mint, Lavender and Blossom are modeled on Ash. They share one mapping,
// parameterized by the accent ramp it reads, and both halves keep Ash's
// structure: the surfaces stay near-neutral and color goes only where a hand
// lands.
//
//   - The neutral ramp follows Ash's lightness step for step and is cool and
//     nearly achromatic: OKLCH chroma never above .004, hue 210–280. Nothing large
//     takes the theme's color, so a canvas reads as white or grey with a cool
//     hint, and never as a tint. Dark is the same
//     ramp, a near-neutral charcoal.
//   - Color reaches `primary` (buttons, the user's message bubble, links),
//     `primary-hover`, `ring`, `brand`, and nothing else. The accent is a dusty,
//     low-chroma mid-tone of the hue, held just inside AA for a white label.
//   - Each theme's accent is its own hue ramp (`--sky-*`, `--teal-*`, `--violet-*`,
//     `--pink-*`), defined once above and carried by every theme, and the factory
//     below reads the ramp it is given. `--orange-*` keeps Ember's values here.
//     Status ramps stay apart from the accent.
//
// Steps the mapping picks, and why:
//   - `primary` is step 550 of the accent: a white label clears AA on it, and it
//     clears AA as link ink on the canvas. Moving it lighter breaks both. `brand`
//     is the lighter step 300 with dark ink, as Ash does, so logo marks stay soft.
//   - `ring` is step 800 in light and step 500 in dark. The gate holds the ring
//     3:1 away from the canvas *and* from the primary fill, so it sits on the
//     opposite side of the primary from the canvas: deeper than the primary on a
//     light canvas, dimmer than it on a dark one. The dark primary is therefore a
//     pale step 200 (L .875–.895); a mid-tone leaves no room for a ring.
//     `--neutral-700`, the dark `input`, sits at L .30 for the same reason: a
//     lighter field edge pushes the ring, and so the primary, lighter.
//   - Dark muted text is `--neutral-400` and the third tier `--neutral-450`: the
//     light half's `--neutral-500` is held at AA on the canvas, which puts it too
//     dim to carry a dark canvas.

/** The accent ramps a pastel theme can read. */
type PastelAccent = "sky" | "teal" | "violet" | "pink";

const pastelLight = (accent: PastelAccent) =>
  ({
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

    ring: `var(--${accent}-800)`,
    // One step darker than the dividers, as in Ash: a field reads as a field
    // before you focus it.
    input: "var(--neutral-350)",

    primary: `var(--${accent}-550)`,
    "primary-foreground": "var(--neutral-0)",
    "primary-hover": `var(--${accent}-700)`,

    brand: `var(--${accent}-300)`,
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

    running: "var(--blue-300)",

    ...LEGACY_STATUS_LABELS_SLATE_LIGHT,
  }) satisfies ThemeTokens;

const pastelDark = (accent: PastelAccent) =>
  ({
    background: "var(--neutral-950)",
    "chat-canvas": "var(--neutral-950)",
    "app-canvas": "var(--neutral-950)",
    foreground: "var(--neutral-50)",

    surface: "var(--neutral-925)",
    "surface-foreground": "var(--neutral-50)",
    "surface-muted": "var(--neutral-850)",
    "surface-muted-foreground": "var(--neutral-400)",
    "surface-elevated": "var(--neutral-850)",
    "surface-hover": "var(--neutral-750)",

    "muted-foreground": "var(--neutral-400)",
    "subtle-foreground": "var(--neutral-450)",

    ...SHADOWS_DARK,
    "rome-shadow-card-hover": SHADOWS_DARK["rome-shadow-4"],

    border: "var(--neutral-700)",
    "border-strong": "var(--neutral-650)",
    "border-subtle": "var(--neutral-850)",

    ring: `var(--${accent}-500)`,
    input: "var(--neutral-700)",

    primary: `var(--${accent}-200)`,
    "primary-foreground": "var(--neutral-950)",
    "primary-hover": `var(--${accent}-100)`,

    brand: `var(--${accent}-300)`,
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

    running: "var(--blue-200)",

    ...LEGACY_STATUS_LABELS_SLATE_DARK,
  }) satisfies ThemeTokens;

// ─── Sky ───────────────────────────────────────────────────────────────────

/** Sky — Ash's structure on a cool, near-achromatic neutral (hue 262) with a dusty
 *  sky-blue accent (hue 242). `--blue-*` is rotated toward indigo (hue 270), so the
 *  informational blue stays distinguishable from the brand blue. */
const skyPalette: Palette = {
  "neutral-0": "oklch(1 0 262)",
  "neutral-25": "oklch(0.994 0.001 262)",
  "neutral-50": "oklch(0.985 0.004 262)",
  "neutral-100": "oklch(0.976 0.004 262)",
  "neutral-150": "oklch(0.967 0.004 262)",
  "neutral-200": "oklch(0.923 0.004 262)",
  "neutral-250": "oklch(0.898 0.004 262)",
  "neutral-300": "oklch(0.87 0.004 262)",
  "neutral-350": "oklch(0.843 0.004 262)",
  "neutral-400": "oklch(0.784 0.004 262)",
  "neutral-450": "oklch(0.72 0.004 262)",
  "neutral-500": "oklch(0.55 0.004 262)",
  "neutral-550": "oklch(0.5 0.004 262)",
  "neutral-600": "oklch(0.45 0.004 262)",
  "neutral-650": "oklch(0.4 0.004 262)",
  "neutral-700": "oklch(0.3 0.004 262)",
  "neutral-750": "oklch(0.27 0.004 262)",
  "neutral-800": "oklch(0.24 0.004 262)",
  "neutral-850": "oklch(0.215 0.004 262)",
  "neutral-900": "oklch(0.19 0.004 262)",
  "neutral-925": "oklch(0.18 0.004 262)",
  "neutral-950": "oklch(0.14 0.004 262)",
  ...RED,
  ...GREEN_FRESH,
  ...AMBER,
  ...BLUE_INDIGO,
  ...ORANGE,
  ...SKY,
  ...TEAL,
  ...VIOLET,
  ...PINK,
};

const sky: ThemeDefinition = {
  id: "sky",
  label: "Sky",
  palette: skyPalette,
  light: pastelLight("sky"),
  dark: pastelDark("sky"),
};

// ─── Mint ──────────────────────────────────────────────────────────────────

/** Mint — Ash's structure on a cool grey neutral (hue 210) with a seafoam-sage
 *  accent (hue 174) at low chroma, so it reads as eucalyptus and not as a success
 *  state. `--green-*` is a yellower grass green (hue 135), which keeps the two apart.
 *  The accent is held a notch darker than its siblings: a green clears AA for a
 *  white label at lower lightness. */
const mintPalette: Palette = {
  "neutral-0": "oklch(1 0 210)",
  "neutral-25": "oklch(0.994 0.003 210)",
  "neutral-50": "oklch(0.985 0.004 210)",
  "neutral-100": "oklch(0.976 0.004 210)",
  "neutral-150": "oklch(0.967 0.004 210)",
  "neutral-200": "oklch(0.923 0.004 210)",
  "neutral-250": "oklch(0.898 0.004 210)",
  "neutral-300": "oklch(0.87 0.004 210)",
  "neutral-350": "oklch(0.843 0.004 210)",
  "neutral-400": "oklch(0.784 0.004 210)",
  "neutral-450": "oklch(0.72 0.004 210)",
  "neutral-500": "oklch(0.55 0.004 210)",
  "neutral-550": "oklch(0.5 0.004 210)",
  "neutral-600": "oklch(0.45 0.004 210)",
  "neutral-650": "oklch(0.4 0.004 210)",
  "neutral-700": "oklch(0.3 0.004 210)",
  "neutral-750": "oklch(0.27 0.004 210)",
  "neutral-800": "oklch(0.24 0.004 210)",
  "neutral-850": "oklch(0.215 0.004 210)",
  "neutral-900": "oklch(0.19 0.004 210)",
  "neutral-925": "oklch(0.18 0.004 210)",
  "neutral-950": "oklch(0.14 0.004 210)",
  ...RED,
  ...GREEN_GRASS,
  ...AMBER,
  ...BLUE,
  ...ORANGE,
  ...SKY,
  ...TEAL,
  ...VIOLET,
  ...PINK,
};

const mint: ThemeDefinition = {
  id: "mint",
  label: "Mint",
  palette: mintPalette,
  light: pastelLight("teal"),
  dark: pastelDark("teal"),
};

// ─── Lavender ──────────────────────────────────────────────────────────────

/** Lavender — Ash's structure on a cool neutral (hue 280) with a quiet blue-violet
 *  accent (hue 286), between indigo and a true lilac. The informational
 *  blue stays the standard hue-250 ramp, a clear step away from the brand. */
const lavenderPalette: Palette = {
  "neutral-0": "oklch(1 0 280)",
  "neutral-25": "oklch(0.994 0.001 280)",
  "neutral-50": "oklch(0.985 0.004 280)",
  "neutral-100": "oklch(0.976 0.004 280)",
  "neutral-150": "oklch(0.967 0.004 280)",
  "neutral-200": "oklch(0.923 0.004 280)",
  "neutral-250": "oklch(0.898 0.004 280)",
  "neutral-300": "oklch(0.87 0.004 280)",
  "neutral-350": "oklch(0.843 0.004 280)",
  "neutral-400": "oklch(0.784 0.004 280)",
  "neutral-450": "oklch(0.72 0.004 280)",
  "neutral-500": "oklch(0.55 0.004 280)",
  "neutral-550": "oklch(0.5 0.004 280)",
  "neutral-600": "oklch(0.45 0.004 280)",
  "neutral-650": "oklch(0.4 0.004 280)",
  "neutral-700": "oklch(0.3 0.004 280)",
  "neutral-750": "oklch(0.27 0.004 280)",
  "neutral-800": "oklch(0.24 0.004 280)",
  "neutral-850": "oklch(0.215 0.004 280)",
  "neutral-900": "oklch(0.19 0.004 280)",
  "neutral-925": "oklch(0.18 0.004 280)",
  "neutral-950": "oklch(0.14 0.004 280)",
  ...RED,
  ...GREEN_FRESH,
  ...AMBER,
  ...BLUE,
  ...ORANGE,
  ...SKY,
  ...TEAL,
  ...VIOLET,
  ...PINK,
};

const lavender: ThemeDefinition = {
  id: "lavender",
  label: "Lavender",
  palette: lavenderPalette,
  light: pastelLight("violet"),
  dark: pastelDark("violet"),
};

// ─── Blossom ───────────────────────────────────────────────────────────────

/** Blossom — Ash's structure on a cool, essentially achromatic neutral (hue 280, so
 *  nothing large goes pink) with a dusty mauve-rose accent (hue 352). The accent
 *  leans toward blue, away from the red ramp (hue 27), so it reads as a quiet pink
 *  and a destructive action is not mistaken for the brand. */
const blossomPalette: Palette = {
  "neutral-0": "oklch(1 0 280)",
  "neutral-25": "oklch(0.994 0.001 280)",
  "neutral-50": "oklch(0.985 0.004 280)",
  "neutral-100": "oklch(0.976 0.004 280)",
  "neutral-150": "oklch(0.967 0.004 280)",
  "neutral-200": "oklch(0.923 0.004 280)",
  "neutral-250": "oklch(0.898 0.004 280)",
  "neutral-300": "oklch(0.87 0.004 280)",
  "neutral-350": "oklch(0.843 0.004 280)",
  "neutral-400": "oklch(0.784 0.004 280)",
  "neutral-450": "oklch(0.72 0.004 280)",
  "neutral-500": "oklch(0.55 0.004 280)",
  "neutral-550": "oklch(0.5 0.004 280)",
  "neutral-600": "oklch(0.45 0.004 280)",
  "neutral-650": "oklch(0.4 0.004 280)",
  "neutral-700": "oklch(0.3 0.004 280)",
  "neutral-750": "oklch(0.27 0.004 280)",
  "neutral-800": "oklch(0.24 0.004 280)",
  "neutral-850": "oklch(0.215 0.004 280)",
  "neutral-900": "oklch(0.19 0.004 280)",
  "neutral-925": "oklch(0.18 0.004 280)",
  "neutral-950": "oklch(0.14 0.004 280)",
  ...RED,
  ...GREEN_FRESH,
  ...AMBER,
  ...BLUE,
  ...ORANGE,
  ...SKY,
  ...TEAL,
  ...VIOLET,
  ...PINK,
};

const blossom: ThemeDefinition = {
  id: "blossom",
  label: "Blossom",
  palette: blossomPalette,
  light: pastelLight("pink"),
  dark: pastelDark("pink"),
};

/** The themes compiled into the bundle. Order is presentation order in the
 *  picker. The first entry is the default (see DEFAULT_THEME_NAME). */
export const BUILTIN_THEMES: ThemeDefinition[] = [ember, ash, slate, sky, mint, lavender, blossom];
