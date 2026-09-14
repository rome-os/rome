import { createContext } from "react";
import type { ResolvedTheme, ThemeName, ThemePreference } from "../lib/theme";

export interface ThemeContextValue {
  preference: ThemePreference;
  resolved: ResolvedTheme;
  setPreference: (next: ThemePreference) => void;
  toggle: () => void;
  theme: ThemeName;
  setTheme: (next: ThemeName) => void;
  themes: { id: ThemeName; label: string }[];
}

// Keep context identity stable when theme definitions hot-reload.
export const ThemeContext = createContext<ThemeContextValue | null>(null);
