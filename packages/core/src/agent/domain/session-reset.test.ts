import { describe, expect, it } from "@rstest/core";
import { evaluateProviderSessionReset } from "./session-reset.js";

describe("provider session reset", () => {
  it("uses the existing last_active_at value for idle boundaries", () => {
    const generation = {
      createdAt: new Date("2026-07-01T00:00:00Z"),
      lastActiveAt: new Date("2026-07-02T00:00:00Z"),
    };
    const policy = { mode: "idle", idleMinutes: 10_080 } as const;

    expect(
      evaluateProviderSessionReset(policy, generation, new Date("2026-07-08T23:59:00Z")).due,
    ).toBe(false);
    expect(
      evaluateProviderSessionReset(policy, generation, new Date("2026-07-09T00:00:00Z")),
    ).toMatchObject({ due: true, reason: "idle" });
  });

  it("compares daily reset buckets at the configured UTC hour", () => {
    const policy = { mode: "daily", atHour: 4 } as const;
    const beforeBoundary = {
      createdAt: new Date("2026-08-04T03:50:00Z"),
      lastActiveAt: new Date("2026-08-04T03:50:00Z"),
    };

    expect(
      evaluateProviderSessionReset(policy, beforeBoundary, new Date("2026-08-04T03:59:00Z")).due,
    ).toBe(false);
    expect(
      evaluateProviderSessionReset(policy, beforeBoundary, new Date("2026-08-04T04:00:00Z")),
    ).toMatchObject({ due: true, reason: "daily" });

    const afterBoundary = {
      createdAt: new Date("2026-08-04T04:05:00Z"),
      lastActiveAt: new Date("2026-08-04T04:05:00Z"),
    };
    expect(
      evaluateProviderSessionReset(policy, afterBoundary, new Date("2026-08-04T20:00:00Z")).due,
    ).toBe(false);
    expect(
      evaluateProviderSessionReset(policy, afterBoundary, new Date("2026-08-05T04:00:00Z")).due,
    ).toBe(true);
  });

  it("never rotates none due to time", () => {
    expect(
      evaluateProviderSessionReset(
        { mode: "none" },
        {
          createdAt: new Date("2020-01-01T00:00:00Z"),
          lastActiveAt: new Date("2020-01-01T00:00:00Z"),
        },
        new Date("2030-01-01T00:00:00Z"),
      ).due,
    ).toBe(false);
  });
});
