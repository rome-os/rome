import { describe, expect, it } from "@rstest/core";
import i18n, {
  LANGUAGE_LABELS,
  normalizeDetectedLanguage,
  resources,
  SUPPORTED_LANGUAGES,
} from "./index";

type Resource = Record<string, unknown>;

function flatten(obj: Resource, prefix = ""): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(obj)) {
    const full = prefix ? `${prefix}.${key}` : key;
    if (value && typeof value === "object" && !Array.isArray(value)) {
      Object.assign(out, flatten(value as Resource, full));
    } else if (typeof value === "string") {
      out[full] = value;
    } else {
      throw new Error(`Unexpected value type at ${full}: ${typeof value}`);
    }
  }
  return out;
}

describe("i18n resources", () => {
  const baseLang = "en" as const;
  const baseBundles = resources[baseLang];
  const namespaces = Object.keys(baseBundles) as Array<keyof typeof baseBundles>;

  for (const ns of namespaces) {
    describe(`namespace ${String(ns)}`, () => {
      const baseKeys = Object.keys(flatten(baseBundles[ns] as Resource)).sort();

      for (const lang of SUPPORTED_LANGUAGES) {
        if (lang === baseLang) continue;

        it(`${lang} has the same keys as ${baseLang}`, () => {
          const langBundle = (resources[lang] as Record<string, Resource>)[ns as string];
          expect(langBundle, `missing namespace ${String(ns)} in ${lang}`).toBeDefined();
          const langKeys = Object.keys(flatten(langBundle)).sort();
          expect(langKeys).toEqual(baseKeys);
        });

        it(`${lang} translations are non-empty strings`, () => {
          const langBundle = (resources[lang] as Record<string, Resource>)[ns as string];
          const flat = flatten(langBundle);
          for (const [key, value] of Object.entries(flat)) {
            expect(value, `empty translation for ${String(ns)}.${key} in ${lang}`).toBeTruthy();
          }
        });
      }
    });
  }
});

describe("i18n default policy", () => {
  it("prefers explicit choice, then the system language, then falls back to en", () => {
    expect(i18n.options.fallbackLng).toEqual(["en"]);
    const detection = i18n.options.detection as {
      order: string[];
      convertDetectedLanguage?: (code: string) => string;
    };
    expect(detection.order).toEqual(["localStorage", "navigator"]);
    // Detected codes must be collapsed onto shipped languages before i18next
    // matches them — its own best-match scan skips codes it can't match, so a
    // secondary exact zh-CN would beat an unsupported primary (ja-JP) or a
    // fuzzy-matching one (en-US).
    expect(detection.convertDetectedLanguage).toBe(normalizeDetectedLanguage);
  });

  const resolutionCases: Array<[string[], string]> = [
    [["zh-CN", "zh"], "zh-CN"],
    [["zh-TW"], "zh-CN"],
    [["zh-Hans-CN", "zh-Hans", "zh"], "zh-CN"],
    [["en-US", "en"], "en"],
    [["en-GB"], "en"],
    // The primary system language wins even when a lower-priority entry is an
    // exact supported code…
    [["en-US", "zh-CN"], "en"],
    [["zh-TW", "en"], "zh-CN"],
    // …including when the primary is a language Rome doesn't ship: it resolves
    // to English rather than letting a secondary zh-CN take over.
    [["ja-JP", "zh-CN"], "en"],
    [["ko-KR", "zh-CN", "zh"], "en"],
    // Neither English nor Chinese → English.
    [["ja-JP", "ja"], "en"],
    [["fr-FR", "fr"], "en"],
    [[], "en"],
  ];

  for (const [systemLanguages, expected] of resolutionCases) {
    it(`system languages [${systemLanguages.join(", ")}] resolve to ${expected}`, () => {
      // Mirrors the runtime chain: the detector maps navigator.languages
      // through convertDetectedLanguage, then i18next picks the best supported
      // match, defaulting to fallbackLng (en).
      const detected = systemLanguages.map(normalizeDetectedLanguage);
      expect(i18n.services.languageUtils.getBestMatchFromCodes(detected)).toBe(expected);
    });
  }

  it("init completes synchronously (initImmediate:false + bundled resources)", () => {
    // If init were async, isInitialized would be false at module-import time
    // and t() would silently return keys. Resources are bundled inline so
    // there is no async work; assert the contract holds.
    expect(i18n.isInitialized).toBe(true);
  });
});

describe("LANGUAGE_LABELS picker contract", () => {
  it("has a native-script label for every supported language", () => {
    for (const lang of SUPPORTED_LANGUAGES) {
      expect(LANGUAGE_LABELS[lang], `missing label for ${lang}`).toBeTruthy();
    }
    // And no extras: keys of LANGUAGE_LABELS must not exceed SUPPORTED_LANGUAGES.
    expect(Object.keys(LANGUAGE_LABELS).sort()).toEqual([...SUPPORTED_LANGUAGES].sort());
  });
});

describe("i18n runtime resolution", () => {
  for (const lang of SUPPORTED_LANGUAGES) {
    it(`changeLanguage(${lang}) actually resolves to ${lang}, not a fallback`, async () => {
      await i18n.changeLanguage(lang);
      expect(i18n.resolvedLanguage).toBe(lang);
      expect(i18n.languages[0]).toBe(lang);
      const sample = i18n.t("nav.apps", { ns: "common" });
      const expected = (resources[lang].common as Record<string, Record<string, string>>).nav.apps;
      expect(sample).toBe(expected);
    });
  }
});
