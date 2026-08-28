import { describe, expect, it } from "@rstest/core";
import { filterChannelApiResponseHeaders } from "./api-request.js";

describe("channel provider API response projection", () => {
  it("filters and sorts unsafe response headers", () => {
    expect(
      filterChannelApiResponseHeaders([
        ["X-RateLimit-Remaining", "4"],
        ["Set-Cookie", "secret"],
        ["Content-Type", "application/json"],
        ["Authorization", "Bot secret"],
      ]),
    ).toEqual({
      "content-type": "application/json",
      "x-ratelimit-remaining": "4",
    });
  });
});
