import { describe, expect, it } from "@rstest/core";
import {
  MODEL_CATALOG,
  LEGACY_MODEL_SELECTIONS,
  canonicalModelSelection,
  fixedNativeModel,
  modelDisplayName,
  modelIdentityKey,
  modelIdentityOf,
  readModelSelectionInput,
} from "../packages/api-types/src/models.js";

describe("fixed model identity", () => {
  it.each(Object.entries(LEGACY_MODEL_SELECTIONS))("freezes old choice %s at %s", (old, key) => {
    expect(canonicalModelSelection(old)).toBe(key);
    expect(modelIdentityKey(modelIdentityOf(old)!)).toBe(key);
    expect(canonicalModelSelection(key)).toBe(key);
  });
  it("preserves context suffixes, dots, dates and unknown values", () => {
    expect(modelIdentityOf("claude-opus")).toEqual({
      providerId: "anthropic",
      modelId: "claude-opus-4-8[1m]",
    });
    expect(fixedNativeModel("anthropic", "claude-opus-5-5")).toBe("claude-opus-5-5");
    expect(fixedNativeModel("anthropic", "claude-sonnet-4-5-20250929")).toBe(
      "claude-sonnet-4-5-20250929",
    );
    expect(fixedNativeModel("openai", "gpt-6.1-sol:high")).toBe("gpt-6.1-sol:high");
    expect(fixedNativeModel("anthropic", "future-model[1m]")).toBe("future-model[1m]");
    expect(canonicalModelSelection("unknown")).toBeNull();
    expect(modelDisplayName("unknown")).toBe("unknown");
    expect(modelDisplayName("opus")).toBe("opus");
    expect(() =>
      readModelSelectionInput({
        modelSelection: { providerId: "anthropic", modelId: "claude-opus-5-5" },
      }),
    ).toThrow();
  });
  it.each([
    "opus",
    "OPUS",
    "opus[1m]",
    "claude-opus-latest[1m]",
    "sonnet",
    "default",
    "gpt-latest",
  ])("does not offer floating native alias %s", (alias) => {
    expect(() => fixedNativeModel("anthropic", alias)).toThrow();
    expect(() =>
      readModelSelectionInput({ modelSelection: { providerId: "anthropic", modelId: alias } }),
    ).toThrow();
  });
  it("qualifies provider-native IDs without confusing nested slashes", () => {
    expect(
      modelIdentityKey({ providerId: "openrouter", modelId: "anthropic/claude-opus-4.8" }),
    ).toBe("openrouter/anthropic/claude-opus-4.8");
    expect(new Set(MODEL_CATALOG.map(modelIdentityKey)).size).toBe(MODEL_CATALOG.length);
    for (const entry of MODEL_CATALOG) expect(modelIdentityKey(entry)).toBe(entry.id);
  });
  it("accepts structured identities and legacy values only when both agree", () => {
    const identity = { providerId: "anthropic", modelId: "claude-opus-4-8[1m]" };
    expect(
      readModelSelectionInput({ largeModelSelection: "claude-opus", modelSelection: identity }),
    ).toBe("anthropic/claude-opus-4-8[1m]");
    expect(() =>
      readModelSelectionInput({ largeModelSelection: "claude-opus-5-5", modelSelection: identity }),
    ).toThrow();
    expect(() => readModelSelectionInput({ largeModelSelection: "unknown" })).toThrow();
    expect(readModelSelectionInput({ modelSelection: null })).toBe("auto");
    expect(readModelSelectionInput({})).toBeUndefined();
  });
});
