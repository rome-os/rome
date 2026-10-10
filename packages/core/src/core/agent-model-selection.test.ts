import { describe, expect, it } from "@rstest/core";
import { resolveAgentModelRequest } from "./agent-model-selection.js";
import { WEBCHAT_LARGE_MODEL_SELECTIONS, type ModelSelectionId } from "./model-selector.js";

const config = { providerId: "openai" as const, modelId: "gpt-5.3-codex-spark" };
const sessionPin = { providerId: "anthropic" as const, model: "saved-model[1m]" };

describe("resolveAgentModelRequest", () => {
  it("resolves a no-tier config to an exact provider/model pair", () => {
    expect(resolveAgentModelRequest(config)).toEqual({
      exact: { providerId: "openai", model: "gpt-5.3-codex-spark" },
    });
  });

  it("does not require exact IDs to appear in the WebChat catalog", () => {
    expect(
      resolveAgentModelRequest({ providerId: "anthropic", modelId: "future-model[1m]" }),
    ).toEqual({ exact: { providerId: "anthropic", model: "future-model[1m]" } });
  });

  it("preserves the saved session provider and model over a changed agent config", () => {
    expect(resolveAgentModelRequest(config, undefined, sessionPin)).toEqual({ exact: sessionPin });
  });

  it("preserves the saved model over a tier default", () => {
    expect(resolveAgentModelRequest({ tier: "small" }, undefined, sessionPin)).toEqual({
      exact: sessionPin,
    });
  });

  it.each(
    Object.keys(WEBCHAT_LARGE_MODEL_SELECTIONS) as ModelSelectionId[],
  )("lets explicit selection %s override both the saved and agent pins without a tier", (selectionId) => {
    const { providerId, model } = WEBCHAT_LARGE_MODEL_SELECTIONS[selectionId];
    expect(resolveAgentModelRequest(config, selectionId, sessionPin)).toEqual({
      exact: { providerId, model },
    });
  });

  it("uses the provider's model ID rather than the WebChat selection slug", () => {
    expect(resolveAgentModelRequest(config, "gpt-5-6-terra")).toEqual({
      exact: { providerId: "openai", model: "gpt-5.6-terra" },
    });
  });

  it.each(["large", "medium", "small"] as const)("preserves tier %s", (tier) => {
    expect(resolveAgentModelRequest({ tier })).toEqual({ tier, providerId: undefined });
    expect(resolveAgentModelRequest({ tier, providerId: "anthropic" })).toEqual({
      tier,
      providerId: "anthropic",
    });
  });

  it("rejects a missing selection instead of adding an implicit tier", () => {
    expect(() => resolveAgentModelRequest({})).toThrow("requires a tier");
    expect(() => resolveAgentModelRequest({ providerId: "openai" })).toThrow("requires a tier");
  });

  it("rejects invalid programmatic exact configs instead of falling back", () => {
    expect(() => resolveAgentModelRequest({ modelId: "exact-model" })).toThrow(
      "requires a provider",
    );
    expect(() => resolveAgentModelRequest({ providerId: "openai", modelId: "" })).toThrow(
      "requires a provider",
    );
    expect(() => resolveAgentModelRequest({ ...config, tier: "large" })).toThrow(
      "cannot be combined with tier",
    );
  });
});
