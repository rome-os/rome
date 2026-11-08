import { describe, expect, it } from "@rstest/core";
import { assertProviderSessionResetPolicy } from "./reset-policy.js";

describe("provider session reset policy", () => {
  it.each([
    { mode: "none" },
    { mode: "idle", idleMinutes: 1 },
    { mode: "idle", idleMinutes: 525_600 },
    { mode: "daily", atHour: 0 },
    { mode: "daily", atHour: 23 },
  ])("accepts $mode policy values", (policy) => {
    expect(() => assertProviderSessionResetPolicy(policy)).not.toThrow();
  });

  it.each([
    { mode: "none", idleMinutes: 10 },
    { mode: "idle", idleMinutes: 0 },
    { mode: "idle", idleMinutes: 1.5 },
    { mode: "daily", atHour: 24 },
    { mode: "daily", atHour: 4, extra: true },
    { mode: "weekly" },
  ])("rejects invalid atomic policy %#", (policy) => {
    expect(() => assertProviderSessionResetPolicy(policy)).toThrow();
  });
});
