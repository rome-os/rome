import { useCallback, useContext, useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { ThemeContext, type ThemeContextValue } from "./theme-context";
import {
  applyTheme,
  applyThemeName,
  getThemeDefinitions,
  readStoredPreference,
  readStoredThemeName,
  resolveTheme,
  systemPrefersDark,
  THEME_NAME_STORAGE_KEY,
  THEME_STORAGE_KEY,
  type ResolvedTheme,
  type ThemeName,
  type ThemePreference,
} from "../lib/theme";

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [preference, setPreferenceState] = useState<ThemePreference>(() => readStoredPreference());
  const [systemDark, setSystemDark] = useState<boolean>(() => systemPrefersDark());
  const [theme, setThemeState] = useState<ThemeName>(() => readStoredThemeName());

  // Snapshot the registry once. Safe while getThemeDefinitions() is a pure
  // synchronous constant. TODO(Option B): when backend-served themes are merged
  // into the registry, add a registry-version dep here and re-run injectThemeCss
  // so the picker list and the injected CSS track updates.
  const themes = useMemo(() => getThemeDefinitions().map(({ id, label }) => ({ id, label })), []);

  const resolved: ResolvedTheme = useMemo(() => {
    if (preference === "light" || preference === "dark") return preference;
    return systemDark ? "dark" : "light";
  }, [preference, systemDark]);

  // The per-theme CSS is injected synchronously in main.tsx before first render,
  // so the provider doesn't re-inject on mount (see the Option B note above).
  useEffect(() => {
    applyTheme(resolved);
  }, [resolved]);

  useEffect(() => {
    applyThemeName(theme);
  }, [theme]);

  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return;
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = (event: MediaQueryListEvent) => setSystemDark(event.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);

  const setPreference = useCallback((next: ThemePreference) => {
    setPreferenceState(next);
    if (typeof window === "undefined") return;
    if (next === "system") {
      window.localStorage.removeItem(THEME_STORAGE_KEY);
    } else {
      window.localStorage.setItem(THEME_STORAGE_KEY, next);
    }
  }, []);

  const toggle = useCallback(() => {
    setPreference(resolved === "dark" ? "light" : "dark");
  }, [resolved, setPreference]);

  const setTheme = useCallback((next: ThemeName) => {
    setThemeState(next);
    if (typeof window === "undefined") return;
    window.localStorage.setItem(THEME_NAME_STORAGE_KEY, next);
  }, []);

  const value = useMemo<ThemeContextValue>(
    () => ({ preference, resolved, setPreference, toggle, theme, setTheme, themes }),
    [preference, resolved, setPreference, toggle, theme, setTheme, themes],
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error("useTheme must be used inside a ThemeProvider");
  return ctx;
}

export { resolveTheme };
