import { describe, expect, it } from "@rstest/core";
import { shouldShowAiToolUsage } from "@/components/ai-tools-panel";

describe("AI tool usage visibility", () => {
  it("defaults hidden unless the developer setting is enabled", () => {
    expect(
      shouldShowAiToolUsage(false, { loggedIn: true, usage: { checkedAt: "", source: "" } }, true),
    ).toBe(false);
  });

  it("shows only for available signed-in tools when enabled", () => {
    expect(shouldShowAiToolUsage(true, { loggedIn: true }, true)).toBe(true);
    expect(shouldShowAiToolUsage(true, { loggedIn: false }, true)).toBe(false);
    expect(shouldShowAiToolUsage(true, { loggedIn: true }, false)).toBe(false);
  });
});
