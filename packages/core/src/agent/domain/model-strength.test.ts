import { describe, expect, it } from "@rstest/core";
import { followingSelection, selectionOfStrength, strengthOfSelection } from "./model-strength.js";

describe("selectionOfStrength", () => {
  it("names Sonnet and Opus on Claude", () => {
    expect(selectionOfStrength("anthropic", "fast")).toBe("anthropic/claude-sonnet-5-5");
    expect(selectionOfStrength("anthropic", "strong")).toBe("anthropic/claude-opus-5-5[1m]");
  });

  it("names Luna and Sol on Codex, and Terra for a model the account may not use", () => {
    const all = { loggedIn: true };
    expect(selectionOfStrength("openai", "fast", all)).toBe("openai/gpt-6-luna");
    expect(selectionOfStrength("openai", "strong", all)).toBe("openai/gpt-6.1-sol");
    const denied = { loggedIn: true, modelsDenied: ["gpt-6.1-sol", "gpt-6-luna"] };
    expect(selectionOfStrength("openai", "fast", denied)).toBe("openai/gpt-5.6-terra");
    expect(selectionOfStrength("openai", "strong", denied)).toBe("openai/gpt-5.6-terra");
  });
});

describe("strengthOfSelection", () => {
  it("counts Terra as strong where the plan withholds Sol, so a strong chat stays strong", () => {
    const noSol = { loggedIn: true, modelsDenied: ["gpt-6.1-sol"] };
    expect(strengthOfSelection("openai/gpt-5.6-terra", noSol)).toBe("strong");
    expect(followingSelection("openai/gpt-5.6-terra", "anthropic", noSol)).toBe(
      "anthropic/claude-opus-5-5[1m]",
    );
    // Where Sol runs, Terra is the quick fallback.
    expect(strengthOfSelection("openai/gpt-5.6-terra", { loggedIn: true })).toBe("fast");
    expect(strengthOfSelection("openai/gpt-5.6-terra")).toBe("fast");
  });
});
