import { describe, expect, it } from "@rstest/core";
import type { ModelAccountReport } from "./model-account-report.js";
import { claudeLogin, codexLoginKind, sameCodexLogin } from "./model-login.js";

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

describe("codexLoginKind", () => {
  const subscription = { kind: "subscription" } as const;
  const report = (state: ModelAccountReport["state"], accountType?: string) =>
    ({ state, account: { loggedIn: true, accountType } }) as ModelAccountReport;

  it("gives Rome credits and an API credential whatever the account says", () => {
    const credits = { kind: "rome_credits", credentialId: "c", modelsServed: null } as const;
    expect(codexLoginKind(credits, undefined)).toBe("rome_credits");
    expect(codexLoginKind({ kind: "api_credential" }, undefined)).toBe("api_credential");
  });

  it("gives a subscription login only for an account that reports it", () => {
    expect(codexLoginKind(subscription, report("available", "plus"))).toBe("subscription");
    expect(codexLoginKind(subscription, undefined)).toBeUndefined();
    expect(codexLoginKind(subscription, report("available"))).toBeUndefined();
    expect(codexLoginKind(subscription, report("unauthorized", "plus"))).toBeUndefined();
    expect(codexLoginKind(subscription, report("expired", "plus"))).toBeUndefined();
  });
});
