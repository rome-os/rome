import { afterEach, describe, expect, it } from "@rstest/core";
import {
  getEnabledOAuthProviders,
  OAUTH_PROVIDERS,
  OAUTH_PROVIDER_DESCRIPTORS,
  showGoogleOAuth,
  isOAuthProvider,
  isEnabledOAuthProvider,
} from "./oauth-providers.js";

describe("oauth-providers", () => {
  const originalShowGoogleOAuth = process.env.SHOW_GOOGLE_OAUTH;

  afterEach(() => {
    if (originalShowGoogleOAuth === undefined) {
      delete process.env.SHOW_GOOGLE_OAUTH;
    } else {
      process.env.SHOW_GOOGLE_OAUTH = originalShowGoogleOAuth;
    }
  });

  it("exposes descriptors for every listed provider", () => {
    for (const id of OAUTH_PROVIDERS) {
      expect(OAUTH_PROVIDER_DESCRIPTORS[id].id).toBe(id);
      expect(OAUTH_PROVIDER_DESCRIPTORS[id].label).toBeTruthy();
      expect(OAUTH_PROVIDER_DESCRIPTORS[id].description).toBeTruthy();
    }
  });

  it("isOAuthProvider accepts known ids and rejects others", () => {
    expect(isOAuthProvider("google")).toBe(true);
    expect(isOAuthProvider("github")).toBe(true);
    expect(isOAuthProvider("facebook")).toBe(false);
    expect(isOAuthProvider("")).toBe(false);
  });

  it("disables Google OAuth by default", () => {
    delete process.env.SHOW_GOOGLE_OAUTH;

    expect(showGoogleOAuth()).toBe(false);
    expect(getEnabledOAuthProviders()).toEqual(["github", "slack"]);
    expect(isEnabledOAuthProvider("google")).toBe(false);
    expect(isEnabledOAuthProvider("github")).toBe(true);
  });

  it("enables Google OAuth only when the flag is truthy", () => {
    process.env.SHOW_GOOGLE_OAUTH = "true";

    expect(showGoogleOAuth()).toBe(true);
    expect(getEnabledOAuthProviders()).toEqual(["google", "github", "slack"]);
    expect(isEnabledOAuthProvider("google")).toBe(true);
  });
});
