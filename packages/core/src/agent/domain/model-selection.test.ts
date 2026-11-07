import { describe, expect, it } from "@rstest/core";
import { isModelSelectionId, MODEL_SELECTIONS } from "./model-selection.js";

describe("model selections", () => {
  it("keys every selection by its own id", () => {
    for (const [id, selection] of Object.entries(MODEL_SELECTIONS)) {
      expect(selection.id).toBe(id);
    }
  });

  it("recognizes a selection id and nothing else", () => {
    expect(isModelSelectionId("claude-sonnet")).toBe(true);
    expect(isModelSelectionId("gpt-6-luna")).toBe(true);
    expect(isModelSelectionId("auto")).toBe(false);
    expect(isModelSelectionId("toString")).toBe(false);
    expect(isModelSelectionId(42)).toBe(false);
  });
});
