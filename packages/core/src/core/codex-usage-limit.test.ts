import { describe, expect, it } from "@rstest/core";
import {
  CODEX_USAGE_LIMIT_ERROR_INFO,
  codexTurnErrorMessage,
  isCodexUsageLimitError,
} from "./codex-usage-limit.js";

describe("isCodexUsageLimitError", () => {
  it("matches the structured camelCase codexErrorInfo (primary signal)", () => {
    expect(
      isCodexUsageLimitError({
        message: "anything at all",
        codexErrorInfo: CODEX_USAGE_LIMIT_ERROR_INFO,
      }),
    ).toBe(true);
  });

  it("is case-sensitive on the codexErrorInfo value", () => {
    // 0.130.0 serializes the unit variant lowercase-first; the PascalCase form
    // must NOT match (guards against the docs.rs-vs-source discrepancy).
    expect(isCodexUsageLimitError({ message: "boom", codexErrorInfo: "UsageLimitExceeded" })).toBe(
      false,
    );
  });

  it("falls back to the conservative message matcher when codexErrorInfo is absent", () => {
    for (const message of [
      "You've hit your usage limit. Try again in 4 days 2 hours.",
      "You have reached your usage limit",
      "Usage limit reached",
      "usage limit exceeded for this account",
    ]) {
      expect(isCodexUsageLimitError({ message })).toBe(true);
    }
  });

  it("matches a bare string message", () => {
    expect(isCodexUsageLimitError("You've hit your usage limit.")).toBe(true);
    expect(isCodexUsageLimitError("some unrelated failure")).toBe(false);
  });

  it("does not treat generic rate-limit / overload errors as usage-limit", () => {
    for (const message of [
      "Server overloaded; retry later.",
      "rate limit: too many requests",
      "HTTP 429",
      "connection reset",
    ]) {
      expect(isCodexUsageLimitError({ message })).toBe(false);
    }
  });

  it("does not match other structured error variants", () => {
    expect(
      isCodexUsageLimitError({
        message: "stream failed",
        codexErrorInfo: { responseStreamDisconnected: { httpStatusCode: 500 } },
      }),
    ).toBe(false);
    expect(isCodexUsageLimitError({ codexErrorInfo: "contextWindowExceeded" })).toBe(false);
  });

  it("handles null/undefined/non-object inputs", () => {
    expect(isCodexUsageLimitError(undefined)).toBe(false);
    expect(isCodexUsageLimitError(null)).toBe(false);
    expect(isCodexUsageLimitError(42)).toBe(false);
  });
});

describe("codexTurnErrorMessage", () => {
  it("prefers the structured message", () => {
    expect(codexTurnErrorMessage({ message: "real reason" }, "fallback")).toBe("real reason");
  });
  it("accepts a bare string", () => {
    expect(codexTurnErrorMessage("plain", "fallback")).toBe("plain");
  });
  it("uses the fallback when no message is present", () => {
    expect(codexTurnErrorMessage(undefined, "fallback")).toBe("fallback");
    expect(codexTurnErrorMessage({ codexErrorInfo: "usageLimitExceeded" }, "fallback")).toBe(
      "fallback",
    );
  });
});
