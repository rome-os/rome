import type { Preview } from "storybook-react-rsbuild";
import { useLayoutEffect, type ReactNode } from "react";
import { I18nextProvider } from "react-i18next";
import i18n, { getActiveLocale, LANGUAGE_LABELS, SUPPORTED_LANGUAGES } from "../src/i18n";
import { storyLocale } from "./locale";
import { ThemeProvider, useTheme } from "../src/hooks/use-theme";
import {
  applyTheme,
  applyThemeName,
  injectThemeCss,
  readStoredPreference,
  readStoredThemeName,
  resolveTheme,
  type ThemePreference,
} from "../src/lib/theme";
import "../src/globals.css";

injectThemeCss();
applyThemeName(readStoredThemeName());
applyTheme(resolveTheme(readStoredPreference()));

export function ColorMode({ mode, children }: { mode: ThemePreference; children: ReactNode }) {
  const { setPreference } = useTheme();
  useLayoutEffect(() => {
    setPreference(mode);
  }, [mode, setPreference]);
  return children;
}

export function Locale({ locale, children }: { locale: string; children: ReactNode }) {
  useLayoutEffect(() => {
    void i18n.changeLanguage(locale);
    document.documentElement.dir = i18n.dir(locale);
  }, [locale]);
  return <I18nextProvider i18n={i18n}>{children}</I18nextProvider>;
}

const preview: Preview = {
  parameters: { layout: "fullscreen" },
  globalTypes: {
    locale: {
      description: "Preview language",
      toolbar: {
        title: "Language",
        icon: "globe",
        dynamicTitle: true,
        items: SUPPORTED_LANGUAGES.map((value) => ({ value, title: LANGUAGE_LABELS[value] })),
      },
    },
    colorMode: {
      description: "Preview color mode",
      toolbar: {
        title: "Color mode",
        icon: "circlehollow",
        dynamicTitle: true,
        items: [
          { value: "light", title: "Light", icon: "sun" },
          { value: "dark", title: "Dark", icon: "moon" },
          { value: "system", title: "System", icon: "browser" },
        ],
      },
    },
  },
  initialGlobals: { colorMode: readStoredPreference(), locale: storyLocale(getActiveLocale()) },
  decorators: [
    (Story, { globals }) => (
      <ThemeProvider>
        <ColorMode
          mode={
            globals.colorMode === "light" || globals.colorMode === "dark"
              ? globals.colorMode
              : "system"
          }
        >
          <Locale locale={storyLocale(globals.locale)}>
            <Story />
          </Locale>
        </ColorMode>
      </ThemeProvider>
    ),
  ],
};

export default preview;
