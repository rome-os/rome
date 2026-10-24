import { describe, expect, it } from "@rstest/core";
import { formatModelName, formatReasoningEffort } from "./model-display";

describe("formatModelName", () => {
  it.each([
    ["claude-opus-5-5[1m]", "Opus 5.5"],
    ["claude-sonnet-5-5", "Sonnet 5.5"],
    ["claude-haiku-4-5-20251001", "Haiku 4.5"],
    ["claude-opus-4.6", "Opus 4.6"],
    ["claude-opus-4", "Opus 4"],
    ["claude-3-5-sonnet-20241022", "Sonnet 3.5"],
    ["gpt-5.5", "GPT-5.5"],
    ["gpt-5.6-sol", "GPT-5.6 Sol"],
    ["gpt-5.1-codex-max", "GPT-5.1 Codex Max"],
    ["gemini-2.5-pro", "Gemini 2.5 Pro"],
  ])("formats %s as %s", (model, expected) => {
    expect(formatModelName(model)).toBe(expected);
  });

  it("keeps ids it does not recognize", () => {
    expect(formatModelName("MiniMax-M2.7")).toBe("MiniMax-M2.7");
    expect(formatModelName("o3")).toBe("o3");
  });
});

describe("formatReasoningEffort", () => {
  it.each([
    ["high", "High"],
    ["xhigh", "Extra High"],
    ["max", "Max"],
    ["turbo", "Turbo"],
  ])("formats %s as %s", (effort, expected) => {
    expect(formatReasoningEffort(effort)).toBe(expected);
  });
});
