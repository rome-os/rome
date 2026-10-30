import i18n from "i18next";
import LanguageDetector from "i18next-browser-languagedetector";
import { initReactI18next } from "react-i18next";

import { bundleLoader, createBundleBackend } from "./bundle-loader";
import { NAMESPACES } from "./namespaces";

export const SUPPORTED_LANGUAGES = ["en", "zh-CN"] as const;
export type SupportedLanguage = (typeof SUPPORTED_LANGUAGES)[number];

// The locale handed to embedded apps via their bootstrap `shell.locale`. It must
// track the *Rome* language the guardian picked (driven by the i18n detector /
// the in-app language picker), NOT `navigator.language` — the OS/browser locale
// can diverge from the chosen app language, which would e.g. show an app in
// Chinese while Rome is set to English. Resolves to a SUPPORTED_LANGUAGES value.
export function getActiveLocale(): string {
  return i18n.resolvedLanguage || i18n.language || "en";
}

// Native-script labels for the picker.
export const LANGUAGE_LABELS: Record<SupportedLanguage, string> = {
  en: "English",
  "zh-CN": "中文",
};

// Maps a detected BCP-47 code onto the language Rome ships for it: any Chinese
// variant (zh, zh-TW, zh-Hans-…) → zh-CN, everything else → en. Collapsing
// every code to a shipped language keeps the guardian's primary system
// language in charge — i18next's own best-match scan skips codes it can't
// match, so a secondary zh-CN would otherwise beat an unsupported primary
// (ja-JP) or a fuzzy-matching one (en-US).
export function normalizeDetectedLanguage(code: string): string {
  const lower = code.toLowerCase();
  return lower === "zh" || lower.startsWith("zh-") ? "zh-CN" : "en";
}

export const i18nReady: Promise<unknown> = i18n
  .use(LanguageDetector)
  .use(createBundleBackend(bundleLoader))
  .use(initReactI18next)
  .init({
    fallbackLng: "en",
    supportedLngs: SUPPORTED_LANGUAGES,
    defaultNS: "common",
    ns: [...NAMESPACES],
    interpolation: { escapeValue: false },
    detection: {
      // Explicit user choice (cached under rome.lang) always wins; without one,
      // the primary browser/OS language decides — Chinese systems get zh-CN,
      // every other system gets English.
      order: ["localStorage", "navigator"],
      lookupLocalStorage: "rome.lang",
      caches: ["localStorage"],
      convertDetectedLanguage: normalizeDetectedLanguage,
    },
    returnNull: false,
    // Resources come from `bundleLoader`: a language already registered
    // initialises in this tick, any other waits for its chunk. `i18nReady`
    // settles when the detected language and the fallback are in the store.
    // Render only after it, or `t()` returns keys.
    initAsync: false,
  });

if (typeof document !== "undefined") {
  const sync = (lng: string) => {
    document.documentElement.lang = lng;
    document.documentElement.dir = i18n.dir(lng);
  };
  sync(i18n.language || "en");
  i18n.on("languageChanged", sync);
}

export default i18n;
