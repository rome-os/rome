import { describe, expect, it } from "@rstest/core";
import { claudeLogin, sameCodexLogin } from "./model-login.js";

describe("claudeLogin", () => {
  it("prefers a stored credential, then the environment, then the CLI's login", () => {
    expect(claudeLogin({ stored: true, environment: true })).toEqual({
      kind: "api_credential",
      source: "stored",
    });
    expect(claudeLogin({ stored: false, environment: true })).toEqual({
      kind: "api_credential",
      source: "environment",
    });
    expect(claudeLogin({ stored: false, environment: false })).toEqual({ kind: "subscription" });
  });
});

describe("sameCodexLogin", () => {
  it("treats a new credential on Rome credits as another login", () => {
    const credits = { kind: "rome_credits", credentialId: "a" } as const;
    expect(sameCodexLogin(credits, { ...credits })).toBe(true);
    expect(sameCodexLogin(credits, { ...credits, credentialId: "b" })).toBe(false);
    expect(sameCodexLogin(credits, { kind: "subscription" })).toBe(false);
  });
});
