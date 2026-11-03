import {
  applyTheme,
  applyThemeName,
  DEFAULT_THEME_NAME,
  injectThemeCss,
  resolveTheme,
} from "rome-web/src/lib/theme";

/**
 * Dresses the page in the dashboard's default theme and follows the system's
 * light or dark mode. The kit ships token names and the dashboard owns their
 * values (`packages/web/src/lib/themes.ts`), so this reuses the dashboard's own
 * helpers rather than carrying a second copy of the values.
 */
export function startTheme(): void {
  injectThemeCss();
  applyThemeName(DEFAULT_THEME_NAME);
  const apply = () => applyTheme(resolveTheme("system"));
  apply();
  matchMedia("(prefers-color-scheme: dark)").addEventListener("change", apply);
}
