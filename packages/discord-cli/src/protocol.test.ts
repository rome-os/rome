import { describe, expect, it } from "@rstest/core";
import {
  DiscordRequestValidationError,
  normalizeDiscordEndpoint,
  validateDiscordBrokerRequest,
} from "@rome/api-types/discord-broker";

describe("Discord REST broker validation", () => {
  it("normalizes only API-v10-relative endpoints", () => {
    expect(normalizeDiscordEndpoint("users/@me")).toBe("/users/@me");
    expect(normalizeDiscordEndpoint("/channels/123/messages")).toBe("/channels/123/messages");
    for (const endpoint of [
      "https://example.com/users/@me",
      "//example.com/users/@me",
      "../v9/users/@me",
      "%2e%2e/users/@me",
      "users/@me#token",
      "users/@me?limit=1",
      "users\\@me",
    ]) {
      expect(() => normalizeDiscordEndpoint(endpoint), endpoint).toThrow(
        DiscordRequestValidationError,
      );
    }
  });

  it("revalidates method, headers, query pairs, and clamps the timeout", () => {
    expect(
      validateDiscordBrokerRequest({
        version: 1,
        method: "patch",
        endpoint: "channels/123",
        query: [
          ["tag", "a"],
          ["tag", "b"],
        ],
        headers: { "X-Audit-Log-Reason": "Rome" },
        body: { name: "agents" },
        timeoutMs: 500_000,
      }),
    ).toEqual({
      version: 1,
      method: "PATCH",
      endpoint: "/channels/123",
      query: [
        ["tag", "a"],
        ["tag", "b"],
      ],
      headers: { "X-Audit-Log-Reason": "Rome" },
      body: { name: "agents" },
      timeoutMs: 120_000,
    });

    expect(() =>
      validateDiscordBrokerRequest({
        version: 1,
        method: "GET",
        endpoint: "users/@me",
        query: [],
        headers: { aUtHoRiZaTiOn: "secret" },
        body: null,
        timeoutMs: 30_000,
      }),
    ).toThrow("owned by Rome Core");
  });
});
