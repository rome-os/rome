import { describe, expect, it } from "@rstest/core";
import { modelResolutionRequest } from "./model-resolution.js";
import { MODEL_SELECTIONS, type ModelSelectionId } from "./model-selection.js";

const config = { providerId: "openai" as const, modelId: "gpt-5.3-codex-spark" };
const sessionPin = { providerId: "anthropic" as const, model: "saved-model[1m]" };

describe("modelResolutionRequest", () => {
  it("resolves a no-tier config to an exact provider/model pair", () => {
    expect(modelResolutionRequest(undefined, undefined, config)).toEqual({
      kind: "exact",
      providerId: "openai",
      model: "gpt-5.3-codex-spark",
    });
  });

  it("does not require exact IDs to appear in the WebChat catalog", () => {
    expect(
      modelResolutionRequest(undefined, undefined, {
        providerId: "anthropic",
        modelId: "future-model[1m]",
      }),
    ).toEqual({ kind: "exact", providerId: "anthropic", model: "future-model[1m]" });
  });

  it("preserves the saved session provider and model over a changed agent config", () => {
    expect(modelResolutionRequest(undefined, sessionPin, config)).toEqual({
      kind: "exact",
      ...sessionPin,
    });
  });

  it("preserves the saved model over a tier default", () => {
    expect(modelResolutionRequest(undefined, sessionPin, { tier: "small" })).toEqual({
      kind: "exact",
      ...sessionPin,
    });
  });

  it.each(
    Object.keys(MODEL_SELECTIONS) as ModelSelectionId[],
  )("lets explicit selection %s override both the saved and agent pins without a tier", (selectionId) => {
    const { providerId, model } = MODEL_SELECTIONS[selectionId];
    expect(modelResolutionRequest(selectionId, sessionPin, config)).toEqual({
      kind: "exact",
      providerId,
      model,
    });
  });

  it("uses the provider's model ID rather than the WebChat selection slug", () => {
    expect(modelResolutionRequest("gpt-5-6-terra", undefined, config)).toEqual({
      kind: "exact",
      providerId: "openai",
      model: "gpt-5.6-terra",
    });
  });

  it.each(["large", "medium", "small"] as const)("preserves tier %s", (tier) => {
    expect(modelResolutionRequest(undefined, undefined, { tier })).toEqual({
      kind: "tier",
      tier,
      providerId: undefined,
    });
    expect(modelResolutionRequest(undefined, undefined, { tier, providerId: "anthropic" })).toEqual(
      { kind: "tier", tier, providerId: "anthropic" },
    );
  });

  it("rejects a missing selection instead of adding an implicit tier", () => {
    expect(() => modelResolutionRequest(undefined, undefined, {})).toThrow("requires a tier");
    expect(() => modelResolutionRequest(undefined, undefined, { providerId: "openai" })).toThrow(
      "requires a tier",
    );
  });

  it("rejects invalid programmatic exact configs instead of falling back", () => {
    expect(() => modelResolutionRequest(undefined, undefined, { modelId: "exact-model" })).toThrow(
      "requires a provider",
    );
    expect(() =>
      modelResolutionRequest(undefined, undefined, { providerId: "openai", modelId: "" }),
    ).toThrow("requires a provider");
    expect(() =>
      modelResolutionRequest(undefined, undefined, { ...config, tier: "large" }),
    ).toThrow("cannot be combined with tier");
  });
});
