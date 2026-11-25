import { describe, expect, it } from "@rstest/core";
import {
  MODEL_CATALOG,
  LEGACY_MODEL_SELECTIONS,
  canonicalModelSelection,
  modelDisplayName,
  modelIdentityKey,
  readModelSelectionInput,
} from "../packages/api-types/src/models.js";

describe("fixed model identity", () => {
  it.each(Object.entries(LEGACY_MODEL_SELECTIONS))("reads old choice %s as %s", (old, key) => {
    expect(readModelSelectionInput(old)).toBe(key);
    expect(readModelSelectionInput(key)).toBe(key);
  });
  it("keeps the original Opus target and exact context and decimal notation", () => {
    expect(canonicalModelSelection("claude-opus")).toBe("anthropic/claude-opus-4-8[1m]");
    expect(canonicalModelSelection("gpt-6-1-sol")).toBe("openai/gpt-6.1-sol");
    expect(canonicalModelSelection("anthropic/claude-opus-4-8")).toBeNull();
    expect(modelIdentityKey({ providerId: "vendor", modelId: "org/model-20250929[1m]" })).toBe(
      "vendor/org/model-20250929[1m]",
    );
    for (const entry of MODEL_CATALOG) expect(modelIdentityKey(entry)).toBe(entry.id);
    expect(new Set(MODEL_CATALOG.map(modelIdentityKey)).size).toBe(MODEL_CATALOG.length);
  });
  it.each([
    "opus",
    "default",
    "latest",
    "unknown",
    null,
    {},
  ])("rejects unknown new choice %j without guessing a model", (value) => {
    expect(() => readModelSelectionInput(value)).toThrow();
  });
  it("keeps Auto a strategy and unknown runtime names unchanged", () => {
    expect(readModelSelectionInput("auto")).toBe("auto");
    expect(readModelSelectionInput(undefined)).toBeUndefined();
    expect(modelDisplayName("unknown")).toBe("unknown");
  });
});
