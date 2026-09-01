import { describe, expect, it } from "@rstest/core";
import {
  buildMobileAuthorizeUrl,
  parseMobileCallback,
  parseMobileTokenResponse,
  toBase64Url,
  validateOAuthConfiguration,
} from "./oauth-protocol.js";

describe("mobile OAuth protocol", () => {
  it("builds the registered PKCE authorization request", () => {
    const url = new URL(
      buildMobileAuthorizeUrl({
        cloudOrigin: "https://romeos.cc",
        clientId: "rome-mobile-ios",
        redirectUri: "cc.romeos.mobile:/oauth/callback",
        state: "state-1",
        codeChallenge: "challenge-1",
        displayName: "Ray's iPhone",
      }),
    );
    expect(url.origin).toBe("https://romeos.cc");
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      response_type: "code",
      client_id: "rome-mobile-ios",
      redirect_uri: "cc.romeos.mobile:/oauth/callback",
      state: "state-1",
      code_challenge: "challenge-1",
      code_challenge_method: "S256",
      display_name: "Ray's iPhone",
    });
  });

  it("accepts only the exact callback, state, and issuer", () => {
    expect(
      parseMobileCallback({
        callbackUrl:
          "cc.romeos.mobile:/oauth/callback?code=one-time&state=s1&iss=https%3A%2F%2Fromeos.cc",
        expectedRedirectUri: "cc.romeos.mobile:/oauth/callback",
        expectedState: "s1",
        expectedIssuer: "https://romeos.cc",
      }),
    ).toEqual({ code: "one-time" });
    expect(() =>
      parseMobileCallback({
        callbackUrl:
          "cc.evil.mobile:/oauth/callback?code=one-time&state=s1&iss=https%3A%2F%2Fromeos.cc",
        expectedRedirectUri: "cc.romeos.mobile:/oauth/callback",
        expectedState: "s1",
        expectedIssuer: "https://romeos.cc",
      }),
    ).toThrow("did not match");
    expect(() =>
      parseMobileCallback({
        callbackUrl:
          "cc.romeos.mobile:/oauth/callback?code=one-time&state=other&iss=https%3A%2F%2Fromeos.cc",
        expectedRedirectUri: "cc.romeos.mobile:/oauth/callback",
        expectedState: "s1",
        expectedIssuer: "https://romeos.cc",
      }),
    ).toThrow("state");
  });

  it("parses only an opaque bearer device credential", () => {
    expect(
      parseMobileTokenResponse({
        access_token: "romemob_secret",
        token_type: "Bearer",
        device_session_id: "device-1",
      }),
    ).toEqual({ accessToken: "romemob_secret", deviceSessionId: "device-1" });
    expect(() =>
      parseMobileTokenResponse({ access_token: "romemob_secret", token_type: "bearer" }),
    ).toThrow("invalid");
  });

  it("keeps PKCE encodings URL safe", () => {
    expect(toBase64Url("ab+c/==")).toBe("ab-c_");
  });

  it("requires the shared registered custom-scheme callback", () => {
    expect(() =>
      validateOAuthConfiguration("https://romeos.cc", "cc.romeos.mobile:/oauth/callback"),
    ).not.toThrow();
    expect(() =>
      validateOAuthConfiguration(
        "https://romeos.cc",
        "https://romeos.cc/mobile/oauth/android/callback",
      ),
    ).toThrow();
    expect(() =>
      validateOAuthConfiguration(
        "https://romeos.cc",
        "https://romeos.cc/mobile/oauth/ios/callback",
      ),
    ).toThrow();
  });
});
