import { describe, expect, it } from "@rstest/core";
import type { CodexLogin } from "../../../domain/model-login.js";
import { codexFunding } from "./funding.js";

const subscription: CodexLogin = { kind: "subscription" };
const credits: CodexLogin = { kind: "rome_credits", credentialId: "c", modelsServed: null };

describe("codexFunding", () => {
  it("bills Rome credits whenever they are the login", () => {
    expect(codexFunding({ login: credits, accountType: "api_key", loggedIn: true })).toBe(
      "rome_credits",
    );
  });

  it("reads the Codex account type otherwise", () => {
    expect(
      codexFunding({ login: { kind: "api_credential" }, accountType: "api_key", loggedIn: true }),
    ).toBe("byok");
    expect(codexFunding({ login: subscription, accountType: "plus", loggedIn: true })).toBe(
      "subscription",
    );
    expect(codexFunding({ login: subscription, accountType: undefined, loggedIn: undefined })).toBe(
      "unknown",
    );
    expect(codexFunding({ login: subscription, accountType: "plus", loggedIn: false })).toBe(
      "unknown",
    );
  });
});
