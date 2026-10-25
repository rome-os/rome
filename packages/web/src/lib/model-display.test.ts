import { describe, expect, it } from "@rstest/core";
import { modelDisplayName, reasoningEffortDisplayName } from "./model-display";

describe("modelDisplayName", () => {
  it("names a known model id", () => {
    expect(modelDisplayName("claude-opus-5-5[1m]")).toBe("Opus 5.5");
    expect(modelDisplayName("gpt-6.1-sol")).toBe("GPT-6.1 Sol");
  });

  it("shows an unknown id as-is", () => {
    expect(modelDisplayName("MiniMax-M2.7")).toBe("MiniMax-M2.7");
  });
});

describe("reasoningEffortDisplayName", () => {
  it("names a known effort and passes an unknown one through", () => {
    expect(reasoningEffortDisplayName("high")).toBe("High");
    expect(reasoningEffortDisplayName("xhigh")).toBe("Extra High");
    expect(reasoningEffortDisplayName("turbo")).toBe("turbo");
  });
});
