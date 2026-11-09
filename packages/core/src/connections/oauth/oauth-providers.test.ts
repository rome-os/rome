import { afterEach, describe, expect, it } from "@rstest/core";
import {
  normalizeShopifyShopDomain,
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
    expect(getEnabledOAuthProviders()).toEqual(["github", "slack", "shopify"]);
    expect(isEnabledOAuthProvider("google")).toBe(false);
    expect(isEnabledOAuthProvider("github")).toBe(true);
  });

  it("enables Google OAuth only when the flag is truthy", () => {
    process.env.SHOW_GOOGLE_OAUTH = "true";

    expect(showGoogleOAuth()).toBe(true);
    expect(getEnabledOAuthProviders()).toEqual(["google", "github", "slack", "shopify"]);
    expect(isEnabledOAuthProvider("google")).toBe(true);
  });

  it("normalizes a Shopify store from a handle, its domain, or its admin URL", () => {
    expect(normalizeShopifyShopDomain("acme")).toBe("acme.myshopify.com");
    expect(normalizeShopifyShopDomain("https://Acme.myshopify.com/")).toBe("acme.myshopify.com");
    expect(normalizeShopifyShopDomain("https://admin.shopify.com/store/acme")).toBe(
      "acme.myshopify.com",
    );
    expect(normalizeShopifyShopDomain("admin.shopify.com/store/acme-2/products?x=1")).toBe(
      "acme-2.myshopify.com",
    );
    expect(normalizeShopifyShopDomain("acme.com")).toBeNull();
    expect(normalizeShopifyShopDomain("admin.shopify.com/store/")).toBeNull();
    expect(normalizeShopifyShopDomain("evil.com/store/acme")).toBeNull();
  });
});
