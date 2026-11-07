import { describe, expect, it } from "@rstest/core";
import { anthropicFunding } from "./funding.js";

describe("anthropicFunding", () => {
  it("treats an API credential as the guardian's own", () => {
    expect(anthropicFunding({ kind: "api_credential", source: "stored" })).toBe("byok");
    expect(anthropicFunding({ kind: "api_credential", source: "environment" })).toBe("byok");
  });

  it("reads the Claude CLI's login as a subscription", () => {
    expect(anthropicFunding({ kind: "subscription" })).toBe("subscription");
  });
});
