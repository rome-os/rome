import { describe, expect, it } from "@rstest/core";
import { accountAvailability } from "./account-availability.js";
import { USAGE_LIMIT_FALLBACK_MS, usageRefusalAt } from "./refused-turn.js";

const readAt = Date.parse("2026-11-07T00:00:00Z");
const hourLater = new Date(readAt + 3_600_000).toISOString();
const fallback = new Date(readAt + USAGE_LIMIT_FALLBACK_MS).toISOString();
const usage = (resetsAt?: string) => ({
  checkedAt: new Date(readAt).toISOString(),
  source: "test",
  fiveHour: { usedPercent: 100, resetsAt },
});
const capacity = {
  checkedAt: new Date(readAt).toISOString(),
  source: "test",
  fiveHour: { usedPercent: 10 },
};
const signedIn = { loggedIn: true };

describe("accountAvailability", () => {
  it("ranks expired over unauthorized over a usage limit", () => {
    const refusal = usageRefusalAt({ until: hourLater }, readAt);
    expect(
      accountAvailability(
        { loggedIn: false, needsReauth: true },
        usage(hourLater),
        refusal,
        readAt,
      ),
    ).toMatchObject({ state: "expired" });
    expect(
      accountAvailability({ loggedIn: false }, usage(hourLater), refusal, readAt),
    ).toMatchObject({
      state: "unauthorized",
    });
    expect(accountAvailability(signedIn, usage(hourLater), undefined, readAt)).toMatchObject({
      state: "usage_limit_reached",
      usageLimitUntil: hourLater,
    });
  });

  it("ends a limit at the exhausted window's reset rather than the refusal's end", () => {
    const inThreeDays = new Date(readAt + 3 * 24 * 3_600_000).toISOString();
    const assumed = usageRefusalAt({}, readAt);
    // A weekly window outlasts the refusal's assumed end.
    expect(accountAvailability(signedIn, usage(inThreeDays), assumed, readAt)).toMatchObject({
      usageLimitUntil: inThreeDays,
    });
    // A five-hour window may reset before a stated end.
    const stated = usageRefusalAt(
      { until: new Date(readAt + 6 * 3_600_000).toISOString() },
      readAt,
    );
    expect(accountAvailability(signedIn, usage(hourLater), stated, readAt)).toMatchObject({
      usageLimitUntil: hourLater,
    });
    // With no exhausted window the refusal's end holds.
    expect(accountAvailability(signedIn, capacity, assumed, readAt)).toMatchObject({
      state: "usage_limit_reached",
      usageLimitUntil: assumed.until,
    });
  });

  it("assumes the fallback end for an exhausted window with no reset, counted from when the usage was checked", () => {
    expect(accountAvailability(signedIn, usage(), undefined, readAt)).toMatchObject({
      state: "usage_limit_reached",
      usageLimitUntil: fallback,
    });
    // The same usage read again an hour later keeps its end.
    expect(accountAvailability(signedIn, usage(), undefined, readAt + 3_600_000)).toMatchObject({
      usageLimitUntil: fallback,
    });
    // And once that end has passed, it is no longer evidence of a limit.
    expect(
      accountAvailability(signedIn, usage(), undefined, readAt + USAGE_LIMIT_FALLBACK_MS + 1),
    ).toMatchObject({ state: "available" });
  });

  it("reads a refusal whose end has passed as over", () => {
    const refusal = usageRefusalAt({ until: hourLater }, readAt);
    const later = Date.parse(hourLater);
    expect(accountAvailability(signedIn, null, refusal, later)).toMatchObject({
      state: "available",
    });
  });

  it("never limits an account whose usage the provider does not limit", () => {
    const refusal = usageRefusalAt({ until: hourLater }, readAt);
    expect(
      accountAvailability(
        { loggedIn: true, usageLimited: false },
        usage(hourLater),
        refusal,
        readAt,
      ),
    ).toMatchObject({ state: "available" });
  });

  it("carries the later of the refusal's end and the end last reported through unreadable usage", () => {
    const inThreeDays = new Date(readAt + 3 * 24 * 3_600_000).toISOString();
    const refusal = usageRefusalAt({}, readAt);
    const weekly = accountAvailability(signedIn, usage(inThreeDays), refusal, readAt);
    expect(weekly).toMatchObject({ usageLimitUntil: inThreeDays });
    const failed = { checkedAt: new Date(readAt).toISOString(), source: "test", error: "boom" };
    expect(
      accountAvailability(signedIn, failed, refusal, readAt + 3_600_000, weekly),
    ).toMatchObject({
      state: "usage_limit_reached",
      usageLimitUntil: inThreeDays,
    });
    // After the refusal's assumed end, the weekly end still holds.
    const afterRefusal = readAt + USAGE_LIMIT_FALLBACK_MS + 1;
    expect(accountAvailability(signedIn, null, undefined, afterRefusal, weekly)).toMatchObject({
      state: "usage_limit_reached",
      usageLimitUntil: inThreeDays,
    });
  });

  it("reads unreadable usage as no evidence, and keeps the reports as read", () => {
    const failed = { checkedAt: new Date(readAt).toISOString(), source: "test", error: "boom" };
    const status = { loggedIn: true, email: "g@example.com", modelsDenied: ["gpt-6-luna"] };
    const result = accountAvailability(status, failed, undefined, readAt);
    expect(result).toEqual({ state: "available", account: status, usage: failed });
    expect(accountAvailability(status, null, undefined, readAt).usage).toBeUndefined();
  });
});
