import { describe, expect, it } from "@rstest/core";
import { claudeRateLimitUsage } from "./claude-rate-limit.js";

const event = (unifiedWindows: unknown) => ({
  type: "rate_limit_event",
  rate_limit_info: { status: "allowed", unifiedWindows },
});

describe("Claude rate limit usage", () => {
  it("reads allowed events as fractions and Unix seconds", () => {
    const before = Date.now();
    const usage = claudeRateLimitUsage(
      event({
        five_hour: { utilization: 0.29, resetsAt: 1793260800 },
        seven_day: { utilization: 0.12, resetsAt: 1793757600 },
      }),
    );
    expect(usage).toMatchObject({
      source: "claude rate limit event",
      fiveHour: { usedPercent: 29, remainingPercent: 71, resetsAt: "2026-10-29T08:00:00.000Z" },
      sevenDay: { usedPercent: 12, remainingPercent: 88 },
    });
    expect(Date.parse(usage!.checkedAt)).toBeGreaterThanOrEqual(before);
  });
  it.each([
    undefined,
    null,
    [],
    {},
    "garbage",
    { five_hour: null },
    { five_hour: { utilization: "0.29", resetsAt: 1793260800 } },
    { five_hour: { utilization: 1.1, resetsAt: 1793260800 } },
    { seven_day: { utilization: 0.2, resetsAt: Infinity } },
    { five_hour: { utilization: NaN, resetsAt: 1793260800 } },
  ])("ignores missing or malformed windows: %j", (windows) => {
    expect(claudeRateLimitUsage(event(windows))).toBeNull();
  });
  it("ignores other events and accepts a weekly-only window", () => {
    expect(claudeRateLimitUsage({ type: "result" })).toBeNull();
    expect(
      claudeRateLimitUsage(event({ seven_day: { utilization: 1, resetsAt: 1793757600 } }))?.sevenDay
        ?.remainingPercent,
    ).toBe(0);
  });
});
