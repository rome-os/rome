import { describe, expect, it } from "@rstest/core";
import { isAnthropicUsageLimitError } from "./anthropic-usage-limit.js";

describe("isAnthropicUsageLimitError", () => {
  it("matches known Claude usage-cap phrasings", () => {
    for (const message of [
      "Claude usage limit reached. Resets at 3pm.",
      "You've reached your usage limit",
      "You've hit your usage limit",
      "usage limit exceeded",
      "Your usage limit has been reached",
    ]) {
      expect(isAnthropicUsageLimitError(message)).toBe(true);
    }
  });

  it("does NOT match transient rate-limit / overloaded / generic errors", () => {
    for (const message of [
      "rate_limit_error: Number of requests has exceeded your rate limit",
      "Overloaded",
      "HTTP 429 Too Many Requests",
      "connection reset",
      "Agent run failed (error_during_execution)",
    ]) {
      expect(isAnthropicUsageLimitError(message)).toBe(false);
    }
  });

  it("handles non-string input", () => {
    expect(isAnthropicUsageLimitError(undefined)).toBe(false);
    expect(isAnthropicUsageLimitError(null)).toBe(false);
    expect(isAnthropicUsageLimitError({ message: "usage limit reached" })).toBe(false);
  });
});
