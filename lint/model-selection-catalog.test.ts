import { readFileSync } from "node:fs";
import { describe, expect, it } from "@rstest/core";
import { MODEL_SELECTIONS } from "../packages/core/src/agent/domain/model-selection.js";
import { LARGE_MODEL_OPTIONS } from "../packages/web/src/lib/model-options.js";

const names: Record<string, string> = {
  "claude-opus-4-8[1m]": "Opus 4.8",
  "claude-opus-5-5[1m]": "Opus 5.5",
  "claude-opus-5[1m]": "Opus 5",
  "claude-opus-4-6[1m]": "Opus 4.6",
  "claude-sonnet-5-5": "Sonnet 5.5",
  "claude-haiku-5-5": "Haiku 5.5",
  "claude-fable-5-1[1m]": "Fable 5.1",
};

describe("model selection fallback", () => {
  it("keeps every stored selection on the agent domain's exact wire identity", () => {
    const options = LARGE_MODEL_OPTIONS.filter((option) => option.id !== "auto");
    expect(options.map((option) => option.id).sort()).toEqual(Object.keys(MODEL_SELECTIONS).sort());
    for (const option of options) {
      expect(option).toMatchObject(MODEL_SELECTIONS[option.id]);
    }
  });

  it.each(["en", "zh-CN"])("names every Claude version truthfully in %s", (locale) => {
    const { modelSelector } = JSON.parse(
      readFileSync(
        new URL(`../packages/web/src/i18n/locales/${locale}/chat.json`, import.meta.url),
        "utf8",
      ),
    );
    for (const option of LARGE_MODEL_OPTIONS) {
      if (option.providerId !== "anthropic") continue;
      expect(Object.hasOwn(names, option.model)).toBe(true);
      const key = option.labelKey.split(".").at(-1)!;
      expect(modelSelector.options[key]).toBe(names[option.model]);
    }
  });
});
