import { describe, expect, it } from "@rstest/core";
import { anthropicFunding, codexFunding } from "./funding.js";

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

describe("codexFunding", () => {
  it("bills Rome credits whenever they are the app-server default", () => {
    expect(
      codexFunding({ defaultProvider: "rome_credits", accountType: "api_key", loggedIn: true }),
    ).toBe("rome_credits");
  });

  it("reads the Codex account type otherwise", () => {
    expect(codexFunding({ defaultProvider: null, accountType: "api_key", loggedIn: true })).toBe(
      "byok",
    );
    expect(codexFunding({ defaultProvider: null, accountType: "plus", loggedIn: true })).toBe(
      "subscription",
    );
    expect(
      codexFunding({ defaultProvider: null, accountType: undefined, loggedIn: undefined }),
    ).toBe("unknown");
    expect(codexFunding({ defaultProvider: null, accountType: "plus", loggedIn: false })).toBe(
      "unknown",
    );
  });
});
