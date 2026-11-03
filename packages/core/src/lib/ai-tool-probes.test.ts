import { describe, expect, it, rs } from "@rstest/core";

const { liveProbe, cachedProbe } = rs.hoisted(() => ({
  liveProbe: rs.fn(),
  cachedProbe: rs.fn(),
}));

rs.mock("./provider-usage.js", () => ({
  readClaudeOAuthUsage: liveProbe,
  readLiveOrCachedUsage: cachedProbe,
  getErrorMessage: (err: unknown) => String(err),
}));

import { readClaudeUsage } from "./ai-tool-probes.js";

describe("readClaudeUsage", () => {
  it("returns live errors rather than falling back to unmaintained usage files", async () => {
    const failed = {
      checkedAt: "2026-09-28T17:00:00.000Z",
      source: "claude oauth usage",
      error: "Claude usage request failed with HTTP 429",
    };
    liveProbe.mockResolvedValue(failed);

    await expect(readClaudeUsage()).resolves.toEqual(failed);
    expect(liveProbe).toHaveBeenCalledTimes(1);
    expect(cachedProbe).not.toHaveBeenCalled();
  });
});
