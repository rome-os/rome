import { BUILTIN_THEMES, type Palette, type ThemeDefinition, type ThemeTokens } from "./themes";

export type ThemePreference = "light" | "dark" | "system";
export type ResolvedTheme = "light" | "dark";
/** A theme id. Open-ended (not a union) so backend-served themes need no type
 *  change — the set of valid ids is whatever `getThemeDefinitions()` returns. */
export type ThemeName = string;

export const THEME_STORAGE_KEY = "rome-theme";
export const THEME_NAME_STORAGE_KEY = "rome-theme-name";
/** Cache of the active theme's generated CSS, replayed by the index.html
 *  bootstrap to keep first paint flash-free across reloads (incl. themes not in
 *  the static bundle). Written by `applyThemeName`.
 *
 *  The suffix versions the payload's shape. A cached entry outlives the build
 *  that wrote it, so a deploy that changes what `buildThemeCss` emits could
 *  otherwise replay an incompatible payload until the bundle boots. Bump the
 *  suffix whenever the emitted shape changes, and add the old key below. */
export const THEME_CSS_CACHE_KEY = "rome-theme-css-5";

/** Cache keys written by earlier payload shapes. `applyThemeName` clears them on
 *  the next write, so a superseded entry does not sit in storage forever. */
export const SUPERSEDED_THEME_CSS_CACHE_KEYS = [
  "rome-theme-css",
  "rome-theme-css-2",
  "rome-theme-css-3",
  "rome-theme-css-4",
];

/** The product default theme — explicit, not "whichever is first in
 *  BUILTIN_THEMES", so reordering the array for picker presentation can't
 *  silently change the default. Asserted to exist in the registry below. */
export const DEFAULT_THEME_NAME: ThemeName = "ember";

/** The id of the `<style>` element that holds the generated per-theme blocks. */
export const THEME_STYLE_ELEMENT_ID = "rome-theme-tokens";

/**
 * The active theme registry — the single seam Option B (backend-served themes)
 * replaces. Today it returns the compiled-in set; later it merges definitions
 * fetched from the API. Callers (CSS injection, the picker, id validation) go
 * through here, so nothing downstream hard-codes the theme list.
 */
export function getThemeDefinitions(): ThemeDefinition[] {
  return BUILTIN_THEMES;
}

// Fail closed at boot: a default that names no registered theme is a wiring
// bug, not a runtime-recoverable state.
if (!getThemeDefinitions().some((theme) => theme.id === DEFAULT_THEME_NAME)) {
  throw new Error(`DEFAULT_THEME_NAME "${DEFAULT_THEME_NAME}" is not a registered theme`);
}

function isThemeName(value: string | null): value is ThemeName {
  return value !== null && getThemeDefinitions().some((theme) => theme.id === value);
}

export function readStoredPreference(): ThemePreference {
  if (typeof window === "undefined") return "system";
  const raw = window.localStorage.getItem(THEME_STORAGE_KEY);
  if (raw === "light" || raw === "dark") return raw;
  return "system";
}

export function readStoredThemeName(): ThemeName {
  if (typeof window === "undefined") return DEFAULT_THEME_NAME;
  const raw = window.localStorage.getItem(THEME_NAME_STORAGE_KEY);
  return isThemeName(raw) ? raw : DEFAULT_THEME_NAME;
}

export function systemPrefersDark(): boolean {
  if (typeof window === "undefined" || !window.matchMedia) return false;
  return window.matchMedia("(prefers-color-scheme: dark)").matches;
}

export function resolveTheme(preference: ThemePreference): ResolvedTheme {
  if (preference === "light" || preference === "dark") return preference;
  return systemPrefersDark() ? "dark" : "light";
}

/** Mode axis — toggles the `.dark` class + native color-scheme on <html>. */
export function applyTheme(resolved: ResolvedTheme): void {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  root.classList.toggle("dark", resolved === "dark");
  root.style.colorScheme = resolved;
}

/** Theme axis — sets the `data-theme` attribute on <html>, selecting which
 *  theme's token block the semantic names resolve against, and refreshes the
 *  no-flash CSS cache so a reload paints this theme without a flash. */
export function applyThemeName(name: ThemeName): void {
  if (typeof document === "undefined") return;
  document.documentElement.setAttribute("data-theme", name);
  const def = getThemeDefinitions().find((theme) => theme.id === name);
  if (def && typeof window !== "undefined") {
    try {
      window.localStorage.setItem(THEME_CSS_CACHE_KEY, buildThemeCss([def]));
      for (const key of SUPERSEDED_THEME_CSS_CACHE_KEYS) window.localStorage.removeItem(key);
    } catch {
      // localStorage may be unavailable (private mode / quota); a flash on the
      // next reload is the only consequence, not a correctness break.
    }
  }
}

/** Custom-property names we will emit. Anything else is rejected rather than
 *  trusted — this is the boundary backend-served themes (Option B) cross, so the
 *  CSS sink must fail closed on a malformed or hostile definition. */
const SAFE_TOKEN_NAME = /^[a-z][a-z0-9-]*$/i;

function tokensToDecls(tokens: ThemeTokens): string {
  return Object.entries(tokens)
    .filter(([name, value]) => {
      if (!SAFE_TOKEN_NAME.test(name)) {
        console.warn(`[theme] dropping token with unsafe name: ${JSON.stringify(name)}`);
        return false;
      }
      // `{`/`}` are the only characters that let a value escape its declaration
      // block; built-in values (color-mix(), rgb() shadow lists) contain none.
      if (value.includes("{") || value.includes("}")) {
        console.warn(`[theme] dropping token --${name}: value contains braces`);
        return false;
      }
      return true;
    })
    .map(([name, value]) => `  --${name}: ${value};`)
    .join("\n");
}

const TOKEN_REFERENCE = /var\(\s*--([a-z][a-z0-9-]*)\s*\)/gi;

function resolvePaletteReferences(tokens: ThemeTokens, palette: Palette): ThemeTokens {
  return Object.fromEntries(
    Object.entries(tokens).map(([name, value]) => [
      name,
      value.replace(TOKEN_REFERENCE, (reference, token) => {
        const literal = Object.hasOwn(palette, token) ? palette[token] : undefined;
        return literal ?? reference;
      }),
    ]),
  );
}

/**
 * Generate the CSS for the given themes: a `[data-theme="<id>"]` block carrying
 * the theme's whole palette plus its resolved light values, and a
 * `[data-theme="<id>"].dark` block carrying the resolved dark values. Pure —
 * the same input always yields the same string. Every block derives from its
 * `ThemeDefinition`.
 *
 * The palette rides in the light block rather than a block of its own because it
 * spans both modes — a step number tracks lightness across the whole range, and
 * the dark mapping re-points the semantic names at the deep end of the same
 * ramps. Semantic values inline those palette literals so app shadow trees only
 * need to inherit the semantic tokens they consume.
 */
export function buildThemeCss(themes: ThemeDefinition[]): string {
  return themes
    .map(
      (theme) =>
        `[data-theme="${theme.id}"] {\n${tokensToDecls(theme.palette)}\n\n${tokensToDecls(resolvePaletteReferences(theme.light, theme.palette))}\n}\n\n` +
        `[data-theme="${theme.id}"].dark {\n${tokensToDecls(resolvePaletteReferences(theme.dark, theme.palette))}\n}`,
    )
    .join("\n\n");
}

/**
 * Render every registered theme's blocks into a single `<style>` in <head>,
 * creating or replacing it. Idempotent — safe to call again when the registry
 * changes (e.g. once Option B adds fetched themes).
 */
export function injectThemeCss(themes: ThemeDefinition[] = getThemeDefinitions()): void {
  if (typeof document === "undefined") return;
  let style = document.getElementById(THEME_STYLE_ELEMENT_ID) as HTMLStyleElement | null;
  if (!style) {
    style = document.createElement("style");
    style.id = THEME_STYLE_ELEMENT_ID;
    document.head.appendChild(style);
  }
  style.textContent = buildThemeCss(themes);
}
