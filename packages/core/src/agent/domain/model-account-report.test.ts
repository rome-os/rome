import { describe, expect, it } from "@rstest/core";
import {
  accountAllowsModel,
  currentReport,
  type ModelAccountReport,
  providerAuthorized,
  providerUsable,
} from "./model-account-report.js";

const readAt = new Date("2026-11-07T00:00:00Z");
const hourLater = new Date(readAt.getTime() + 3_600_000).toISOString();
const limited: ModelAccountReport = {
  state: "usage_limit_reached",
  usageLimitUntil: hourLater,
  account: { loggedIn: true },
};

describe("currentReport", () => {
  it("reads a passed limit as available and leaves the rest alone", () => {
    expect(currentReport(limited, readAt)).toBe(limited);
    expect(currentReport(limited, new Date(hourLater))).toEqual({
      state: "available",
      account: { loggedIn: true },
    });
    const expired: ModelAccountReport = {
      state: "expired",
      account: { loggedIn: false, needsReauth: true },
    };
    expect(currentReport(expired, new Date(hourLater))).toBe(expired);
  });

  it("reads a limit with an unreadable end as over", () => {
    const odd = { ...limited, usageLimitUntil: "invalid" };
    expect(currentReport(odd, readAt)).toMatchObject({ state: "available" });
  });
});

describe("predicates", () => {
  it("treat an unread provider as usable and authorized", () => {
    expect(providerUsable(undefined)).toBe(true);
    expect(providerAuthorized(undefined)).toBe(true);
    const expired: ModelAccountReport = {
      state: "expired",
      account: { loggedIn: false, needsReauth: true },
    };
    expect(providerUsable(expired)).toBe(false);
    expect(providerAuthorized(expired)).toBe(false);
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
