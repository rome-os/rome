import { describe, expect, it } from "@rstest/core";
import { anthropicUsageLimitReset, isAnthropicUsageLimitError } from "./usage-limit.js";

describe("isAnthropicUsageLimitError", () => {
  it("matches known Claude usage-cap phrasings", () => {
    for (const message of [
      "You've hit your session limit · resets 9:10pm (America/Los_Angeles)",
      "You've hit your weekly limit · resets Nov 5, 9am (America/Los_Angeles)",
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
      "Server is temporarily limiting requests (not your usage limit)",
      ...["Opus", "Sonnet", "Fable"].map(
        (model) => `You've hit your ${model} 5 limit · resets 9am (America/Los_Angeles)`,
      ),
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

// Weekly examples use the CLI formatter's real format, not a captured weekly error.
describe("anthropicUsageLimitReset", () => {
  const now = new Date("2026-11-03T03:00:00Z");
  it.each([
    ["session", "9:10pm (America/Los_Angeles)", "2026-11-03T05:10:00.000Z"],
    ["session", "9pm (America/Los_Angeles) · progress saved", "2026-11-03T05:00:00.000Z"],
    ["session", "4am (UTC)", "2026-11-03T04:00:00.000Z"],
    ["weekly", "Nov 5, 9am (America/Los_Angeles)", "2026-11-05T17:00:00.000Z"],
    ["weekly", "Nov 5, 9:10am (America/Los_Angeles) · ask your admin", "2026-11-05T17:10:00.000Z"],
    ["session", "8am (UTC)", "2026-11-03T08:00:00.000Z"],
    ["weekly", "Nov 10, 3am (UTC)", "2026-11-10T03:00:00.000Z"],
  ])("parses %s reset %s", (kind, time, expected) => {
    expect(anthropicUsageLimitReset(`You've hit your ${kind} limit · resets ${time}`, now)).toBe(
      expected,
    );
  });
  it("parses the year form and the next occurrence across midnight", () => {
    expect(
      anthropicUsageLimitReset(
        "You've hit your weekly limit · resets Jan 2, 2027, 9:10am (America/Los_Angeles)",
        new Date("2026-12-30T17:00:00Z"),
      ),
    ).toBe("2027-01-02T17:10:00.000Z");
    expect(
      anthropicUsageLimitReset(
        "You've hit your session limit · resets 1am (UTC)",
        new Date("2026-11-03T23:00:00Z"),
      ),
    ).toBe("2026-11-04T01:00:00.000Z");
  });
  it.each([
    "session limit · resets 9am (UTC)",
    "weekly limit · resets Nov 10, 3:01am (UTC)",
    "weekly limit · resets Nov 2, 9am (UTC)",
    "session limit · resets 2am (UTC)",
    "session limit · resets 9pm (Bad/Zone)",
    "session limit",
    "session limit · resets 13pm (UTC)",
    "session limit · resets 4:99am (UTC)",
    "weekly limit · resets Xxx 5, 9am (UTC)",
    "weekly limit · resets Feb 30, 2026, 9am (UTC)",
    "Fable 5 limit · resets 4am (UTC)",
    "usage limit · resets 4am (UTC)",
    "session limit · resets 4am (UTC) (not your usage limit)",
  ])("rejects %s", (text) => {
    expect(anthropicUsageLimitReset(`You've hit your ${text}`, now)).toBeUndefined();
  });
});
