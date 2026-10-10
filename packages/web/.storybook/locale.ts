import { SUPPORTED_LANGUAGES, type SupportedLanguage } from "../src/i18n";

export function storyLocale(value: unknown): SupportedLanguage {
  return SUPPORTED_LANGUAGES.find((language) => language === value) ?? "en";
}
