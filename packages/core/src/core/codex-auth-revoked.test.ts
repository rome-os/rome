import { describe, expect, it } from "@rstest/core";
import { CODEX_AUTH_REVOKED_CODE, isCodexAuthRevokedError } from "./codex-auth-revoked.js";

describe("isCodexAuthRevokedError", () => {
  it("matches OpenAI's canonical revoked-refresh-token message", () => {
    expect(
      isCodexAuthRevokedError({
        message:
          "Your access token could not be refreshed because your refresh token was revoked. Please log out and sign in again.",
      }),
    ).toBe(true);
  });

  it("matches a bare string payload (out-of-turn error notification)", () => {
    expect(isCodexAuthRevokedError("refresh token was revoked")).toBe(true);
    expect(isCodexAuthRevokedError("access token could not be refreshed")).toBe(true);
    expect(isCodexAuthRevokedError("please log out and sign in again")).toBe(true);
  });

  it("tolerates wording drift on the revoked phrasing", () => {
    expect(isCodexAuthRevokedError({ message: "the refresh token has been revoked" })).toBe(true);
    expect(isCodexAuthRevokedError({ message: "your refresh token is revoked, sorry" })).toBe(true);
  });

  it("does not match unrelated failures (quota, transient, network)", () => {
    for (const message of [
      "You've hit your usage limit. Try again in 4 days.",
      "stream error: server is overloaded",
      "request timed out",
      "401 Unauthorized",
    ]) {
      expect(isCodexAuthRevokedError({ message })).toBe(false);
      expect(isCodexAuthRevokedError(message)).toBe(false);
    }
  });

  it("returns false for null / non-error shapes", () => {
    expect(isCodexAuthRevokedError(null)).toBe(false);
    expect(isCodexAuthRevokedError(undefined)).toBe(false);
    expect(isCodexAuthRevokedError(42)).toBe(false);
    expect(isCodexAuthRevokedError({ codexErrorInfo: "somethingElse" })).toBe(false);
  });

  it("exposes the stable terminal error code", () => {
    expect(CODEX_AUTH_REVOKED_CODE).toBe("auth_revoked");
  });
});
