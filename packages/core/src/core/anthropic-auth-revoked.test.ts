import { describe, expect, it } from "@rstest/core";
import {
  ANTHROPIC_AUTH_REVOKED_CODE,
  isAnthropicAuthRevokedError,
} from "./anthropic-auth-revoked.js";

describe("isAnthropicAuthRevokedError", () => {
  it("matches the canonical 401 invalid-credentials message", () => {
    expect(
      isAnthropicAuthRevokedError(
        'Failed to authenticate. API Error: 401 {"type":"error","error":{"type":"authentication_error","message":"Invalid authentication credentials"}}',
      ),
    ).toBe(true);
  });

  it("matches revoked / expired OAuth phrasings", () => {
    expect(isAnthropicAuthRevokedError("OAuth token revoked · Please run /login")).toBe(true);
    expect(isAnthropicAuthRevokedError("OAuth token has expired · Please run /login")).toBe(true);
  });

  it("accepts the SDK's errors[] array, an Error, or an object with a message", () => {
    expect(isAnthropicAuthRevokedError(["something else", "authentication_error: bad"])).toBe(true);
    expect(isAnthropicAuthRevokedError(new Error("Invalid authentication credentials"))).toBe(true);
    expect(isAnthropicAuthRevokedError({ message: "failed to authenticate" })).toBe(true);
  });

  it("does NOT match the genuinely-logged-out notice (owned by not-logged-in-notice)", () => {
    expect(isAnthropicAuthRevokedError("Not logged in · Please run /login")).toBe(false);
  });

  it("does not match unrelated failures (quota, overload, network)", () => {
    for (const message of [
      "You've hit your usage limit.",
      "API Error: 529 Overloaded",
      "request timed out",
      "API Error: 500 Internal server error",
    ]) {
      expect(isAnthropicAuthRevokedError(message)).toBe(false);
      expect(isAnthropicAuthRevokedError([message])).toBe(false);
    }
  });

  it("returns false for null / non-error shapes", () => {
    expect(isAnthropicAuthRevokedError(null)).toBe(false);
    expect(isAnthropicAuthRevokedError(undefined)).toBe(false);
    expect(isAnthropicAuthRevokedError(401)).toBe(false);
    expect(isAnthropicAuthRevokedError({})).toBe(false);
  });

  it("shares the provider-agnostic terminal error code", () => {
    expect(ANTHROPIC_AUTH_REVOKED_CODE).toBe("auth_revoked");
  });
});
