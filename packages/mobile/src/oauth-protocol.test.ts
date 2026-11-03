import { describe, expect, it } from "@rstest/core";
import { validateOAuthConfiguration } from "./oauth-protocol.js";

describe("mobile OAuth configuration", () => {
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
