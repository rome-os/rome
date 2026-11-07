import { describe, expect, it } from "@rstest/core";
import { anthropicFunding } from "./funding.js";

describe("anthropicFunding", () => {
  it("treats stored compatible credentials and Anthropic keys as the guardian's own", () => {
    expect(anthropicFunding({ hasCompatibleCredentials: true, env: {} })).toBe("byok");
    expect(
      anthropicFunding({ hasCompatibleCredentials: false, env: { ANTHROPIC_API_KEY: "k" } }),
    ).toBe("byok");
    expect(
      anthropicFunding({ hasCompatibleCredentials: false, env: { ANTHROPIC_AUTH_TOKEN: "t" } }),
    ).toBe("byok");
  });

  it("falls back to the Claude subscription login", () => {
    expect(anthropicFunding({ hasCompatibleCredentials: false, env: {} })).toBe("subscription");
  });
});
