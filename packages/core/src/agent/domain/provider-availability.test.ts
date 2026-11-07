import { describe, expect, it } from "@rstest/core";
import {
  accountAllowsModel,
  availabilityFromAccount,
  currentAvailability,
  providerAuthorized,
  providerUsable,
  USAGE_LIMIT_FALLBACK_MS,
} from "./provider-availability.js";

const readAt = new Date("2026-11-07T00:00:00Z");
const hourLater = new Date(readAt.getTime() + 3_600_000).toISOString();
const fallback = new Date(readAt.getTime() + USAGE_LIMIT_FALLBACK_MS).toISOString();
const usage = (resetsAt?: string) => ({
  checkedAt: readAt.toISOString(),
  source: "test",
  fiveHour: { usedPercent: 100, resetsAt },
});

describe("availabilityFromAccount", () => {
  it("ranks expired over unauthorized over a usage limit", () => {
    expect(
      availabilityFromAccount({ loggedIn: false, needsReauth: true }, usage(hourLater), readAt),
    ).toMatchObject({ state: "expired" });
    expect(availabilityFromAccount({ loggedIn: false }, usage(hourLater), readAt)).toMatchObject({
      state: "unauthorized",
    });
    expect(availabilityFromAccount({ loggedIn: true }, usage(hourLater), readAt)).toMatchObject({
      state: "usage_limit_reached",
      usageLimitUntil: hourLater,
    });
  });

  it("takes the provider's stated refusal time over the usage windows", () => {
    const stated = new Date(readAt.getTime() + 6 * 3_600_000).toISOString();
    expect(
      availabilityFromAccount(
        { loggedIn: true, usageLimitUntil: stated },
        usage(hourLater),
        readAt,
      ),
    ).toMatchObject({ state: "usage_limit_reached", usageLimitUntil: stated });
  });

  it.each([
    null,
    "invalid",
    "2000-01-01T00:00:00Z",
  ])("assumes the fallback end for a refusal with %s time", (until) => {
    expect(
      availabilityFromAccount({ loggedIn: true, usageLimitUntil: until }, null, readAt),
    ).toMatchObject({ state: "usage_limit_reached", usageLimitUntil: fallback });
  });

  it("assumes the fallback end for an exhausted window with no reset", () => {
    expect(availabilityFromAccount({ loggedIn: true }, usage(), readAt)).toMatchObject({
      state: "usage_limit_reached",
      usageLimitUntil: fallback,
    });
  });

  it("never limits an account whose usage the provider does not limit", () => {
    expect(
      availabilityFromAccount(
        { loggedIn: true, usageLimited: false, usageLimitUntil: hourLater },
        usage(hourLater),
        readAt,
      ),
    ).toMatchObject({ state: "available" });
  });

  it("carries a limit still ahead through usage it could not read, and drops a passed one", () => {
    const previous = availabilityFromAccount({ loggedIn: true }, usage(hourLater), readAt);
    expect(availabilityFromAccount({ loggedIn: true }, null, readAt, previous)).toMatchObject({
      state: "usage_limit_reached",
      usageLimitUntil: hourLater,
    });
    const failed = { checkedAt: readAt.toISOString(), source: "test", error: "boom" };
    expect(availabilityFromAccount({ loggedIn: true }, failed, readAt, previous)).toMatchObject({
      state: "usage_limit_reached",
      usage: failed,
    });
    const later = new Date(Date.parse(hourLater) + 1);
    expect(availabilityFromAccount({ loggedIn: true }, null, later, previous)).toMatchObject({
      state: "available",
    });
  });

  it("keeps the account's reports as read and drops unreadable usage", () => {
    const status = { loggedIn: true, email: "g@example.com", modelsDenied: ["gpt-6-luna"] };
    const result = availabilityFromAccount(status, null, readAt);
    expect(result.account).toEqual(status);
    expect(result.usage).toBeUndefined();
  });
});

describe("currentAvailability", () => {
  it("reads a passed limit as available and leaves the rest alone", () => {
    const limited = availabilityFromAccount({ loggedIn: true }, usage(hourLater), readAt);
    expect(currentAvailability(limited, readAt)).toBe(limited);
    const after = new Date(Date.parse(hourLater));
    expect(currentAvailability(limited, after)).toEqual({
      state: "available",
      account: { loggedIn: true },
      usage: usage(hourLater),
    });
  });
});

describe("predicates", () => {
  it("treat an unread provider as usable and authorized", () => {
    expect(providerUsable(undefined)).toBe(true);
    expect(providerAuthorized(undefined)).toBe(true);
    const expired = availabilityFromAccount({ loggedIn: false, needsReauth: true }, null, readAt);
    expect(providerUsable(expired)).toBe(false);
    expect(providerAuthorized(expired)).toBe(false);
    const limited = availabilityFromAccount({ loggedIn: true }, usage(hourLater), readAt);
    expect(providerUsable(limited)).toBe(false);
    expect(providerAuthorized(limited)).toBe(true);
  });

  it("allows any model to an account that withholds none, and withholds aliases of the denied ones", () => {
    expect(accountAllowsModel({ loggedIn: true }, "gpt-6-luna")).toBe(true);
    const restricted = { loggedIn: true, modelsDenied: ["gpt-6.1-sol", "gpt-6-luna"] };
    expect(accountAllowsModel(restricted, "gpt-5.6-terra:high")).toBe(true);
    expect(accountAllowsModel(restricted, "gpt-5.4-mini")).toBe(true);
    expect(accountAllowsModel(restricted, "gpt-6-luna:high")).toBe(false);
    expect(accountAllowsModel(restricted, "gpt-6.1-sol")).toBe(false);
  });
});
