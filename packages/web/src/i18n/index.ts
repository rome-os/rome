import i18n from "i18next";
import LanguageDetector from "i18next-browser-languagedetector";
import { initReactI18next } from "react-i18next";

import enActivity from "./locales/en/activity.json";
import enApps from "./locales/en/apps.json";
import enAuth from "./locales/en/auth.json";
import enChat from "./locales/en/chat.json";
import enCommon from "./locales/en/common.json";
import enRoutines from "./locales/en/routines.json";
import enFiles from "./locales/en/files.json";
import enInbox from "./locales/en/inbox.json";
import enOnboard from "./locales/en/onboard.json";
import enPeople from "./locales/en/people.json";
import enSettings from "./locales/en/settings.json";
import zhActivity from "./locales/zh-CN/activity.json";
import zhApps from "./locales/zh-CN/apps.json";
import zhAuth from "./locales/zh-CN/auth.json";
import zhChat from "./locales/zh-CN/chat.json";
import zhCommon from "./locales/zh-CN/common.json";
import zhRoutines from "./locales/zh-CN/routines.json";
import zhFiles from "./locales/zh-CN/files.json";
import zhInbox from "./locales/zh-CN/inbox.json";
import zhOnboard from "./locales/zh-CN/onboard.json";
import zhPeople from "./locales/zh-CN/people.json";
import zhSettings from "./locales/zh-CN/settings.json";

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

// Native-script labels for the picker. Keep one entry per SUPPORTED_LANGUAGES
// member; the i18n test asserts this stays exhaustive.
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

export const resources = {
  en: {
    common: enCommon,
    settings: enSettings,
    auth: enAuth,
    activity: enActivity,
    routines: enRoutines,
    chat: enChat,
    people: enPeople,
    apps: enApps,
    files: enFiles,
    inbox: enInbox,
    onboard: enOnboard,
  },
  "zh-CN": {
    common: zhCommon,
    settings: zhSettings,
    auth: zhAuth,
    activity: zhActivity,
    routines: zhRoutines,
    chat: zhChat,
    people: zhPeople,
    apps: zhApps,
    files: zhFiles,
    inbox: zhInbox,
    onboard: zhOnboard,
  },
} as const;

i18n
  .use(LanguageDetector)
  .use(initReactI18next)
  .init({
    resources,
    fallbackLng: "en",
    supportedLngs: SUPPORTED_LANGUAGES,
    defaultNS: "common",
    ns: [
      "common",
      "settings",
      "auth",
      "activity",
      "routines",
      "chat",
      "people",
      "apps",
      "files",
      "inbox",
      "onboard",
    ],
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
    // Resources are bundled inline, so there is no async work to wait on —
    // initAsync:false makes init complete synchronously instead of on the
    // next tick, so importers can call t() right away without awaiting.
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
