import type { SupportedLanguage } from "../src/i18n";

export function storyLocale(value: unknown): SupportedLanguage {
  return value === "zh-CN" ? "zh-CN" : "en";
}
