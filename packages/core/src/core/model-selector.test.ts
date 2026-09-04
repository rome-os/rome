import { describe, expect, it } from "@rstest/core";
import {
  DEFAULT_WEBCHAT_LARGE_MODEL_SELECTION,
  normalizeWebchatLargeModelSelectionId,
  resolveWebchatLargeModelSelection,
} from "./model-selector.js";

describe("webchat model selector", () => {
  it("maps Auto to the default provider strategy", () => {
    expect(resolveWebchatLargeModelSelection("auto")).toBeNull();
  });

  it("maps Claude selections to the Anthropic provider", () => {
    expect(resolveWebchatLargeModelSelection("claude-opus")).toMatchObject({
      providerId: "anthropic",
      model: "claude-opus-4-8[1m]",
    });
    expect(resolveWebchatLargeModelSelection("claude-opus-5")).toMatchObject({
      id: "claude-opus-5",
      providerId: "anthropic",
      model: "claude-opus-5[1m]",
    });
    expect(resolveWebchatLargeModelSelection("claude-opus-4-6")).toMatchObject({
      providerId: "anthropic",
      model: "claude-opus-4-6[1m]",
    });
    expect(resolveWebchatLargeModelSelection("claude-sonnet")).toMatchObject({
      providerId: "anthropic",
      model: "claude-sonnet-5",
    });
    expect(resolveWebchatLargeModelSelection("claude-haiku")).toMatchObject({
      providerId: "anthropic",
      model: "claude-haiku-4-5",
    });
    expect(resolveWebchatLargeModelSelection("claude-fable")).toMatchObject({
      providerId: "anthropic",
      model: "claude-fable-5-1[1m]",
    });
  });

  it("maps GPT selections to the Codex provider", () => {
    expect(resolveWebchatLargeModelSelection("gpt-6-astra")).toMatchObject({
      providerId: "openai",
      model: "gpt-6-astra",
    });
    expect(resolveWebchatLargeModelSelection("gpt-5-6-sol")).toMatchObject({
      providerId: "openai",
      model: "gpt-5.6-sol",
    });
    expect(resolveWebchatLargeModelSelection("gpt-5-6-terra")).toMatchObject({
      providerId: "openai",
      model: "gpt-5.6-terra",
    });
    expect(resolveWebchatLargeModelSelection("gpt-5-6-luna")).toMatchObject({
      providerId: "openai",
      model: "gpt-5.6-luna",
    });
  });

  it("falls back to the default selection for unknown values", () => {
    expect(normalizeWebchatLargeModelSelectionId("bogus")).toBe(
      DEFAULT_WEBCHAT_LARGE_MODEL_SELECTION,
    );
    expect(resolveWebchatLargeModelSelection("bogus")).toBeNull();
  });
});
