import { describe, expect, it } from "@rstest/core";
import {
  guardianLanguageInstruction,
  normalizeWelcomeLocale,
  welcomeLocaleFromCode,
} from "./locale.js";
import { getWelcomeCopy } from "./web/lib/copy.js";

describe("normalizeWelcomeLocale", () => {
  it("keeps Chinese and safely falls back to English", () => {
    expect(normalizeWelcomeLocale("zh-CN")).toBe("zh-CN");
    expect(normalizeWelcomeLocale("zh-TW")).toBe("en");
    expect(normalizeWelcomeLocale(undefined)).toBe("en");
  });

  it("selects Chinese copy for the landing entry point", () => {
    expect(getWelcomeCopy("zh-CN").landing.kickoff).toBe("开始设置 👋");
    expect(getWelcomeCopy("zh-CN").landing.start).toBe("开始聊天");
  });

  it("maps each supported locale to its agent instruction", () => {
    expect(guardianLanguageInstruction("en")).toBe("Write every guardian-facing field in English.");
    expect(guardianLanguageInstruction("zh-CN")).toBe(
      "Write every guardian-facing field in Simplified Chinese.",
    );
  });

  it("recognizes only shipped locale codes", () => {
    expect(welcomeLocaleFromCode("en")).toBe("en");
    expect(welcomeLocaleFromCode("zh-CN")).toBe("zh-CN");
    expect(welcomeLocaleFromCode("zh-TW")).toBeUndefined();
  });
});
