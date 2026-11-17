import { describe, expect, it } from "@rstest/core";
import type { ModelAccountReport } from "./model-account-report.js";
import { legacyDefault, reconciledDefault, signedInProviders } from "./default-provider.js";

const available: ModelAccountReport = {
  state: "available",
  account: { loggedIn: true, usageLimited: true },
};
const limited: ModelAccountReport = { ...available, state: "usage_limit_reached" };
const out: ModelAccountReport = { state: "unauthorized", account: { loggedIn: false } };
const all = { anthropic: true, openai: true, rome_credits: true };

describe("legacyDefault", () => {
  it("picks what the old order picked", () => {
    const signedIn = signedInProviders({ openai: available, anthropic: available }, false);
    expect(legacyDefault({ openai: available, anthropic: available }, signedIn)).toBe("openai");
    const onCredits = {
      openai: { ...available, requiresChatgptCredits: true },
      anthropic: available,
    };
    expect(legacyDefault(onCredits, signedInProviders(onCredits, false))).toBe("anthropic");
    const none = { openai: out, anthropic: out };
    expect(legacyDefault(none, signedInProviders(none, true))).toBe("rome_credits");
    expect(legacyDefault(none, signedInProviders(none, false))).toBeNull();
  });

  it("counts a provider at its usage limit, or whose sign-in expired, as signed in", () => {
    expect(signedInProviders({ anthropic: limited }, false).anthropic).toBe(true);
    const expired: ModelAccountReport = { state: "expired", account: { loggedIn: false } };
    expect(signedInProviders({ anthropic: expired }, false).anthropic).toBe(true);
    expect(signedInProviders({ anthropic: out }, false).anthropic).toBe(false);
  });
});

describe("reconciledDefault", () => {
  it("makes the first signed-in provider the default", () => {
    expect(reconciledDefault(null, all, "anthropic")).toEqual({
      provider: "anthropic",
      moved: false,
    });
  });

  it("keeps a signed-in default when another signs in", () => {
    expect(reconciledDefault("anthropic", all, "openai")).toEqual({
      provider: "anthropic",
      moved: false,
    });
  });

  it("moves a removed default to a remaining provider, the guardian's own logins first", () => {
    expect(
      reconciledDefault("openai", { anthropic: true, openai: false, rome_credits: true }, null),
    ).toEqual({ provider: "anthropic", moved: true });
    expect(
      reconciledDefault("anthropic", { anthropic: false, openai: false, rome_credits: true }, null),
    ).toEqual({ provider: "rome_credits", moved: true });
  });

  it("keeps a removed default with none left", () => {
    const none = { anthropic: false, openai: false, rome_credits: false };
    expect(reconciledDefault("openai", none, null)).toEqual({ provider: "openai", moved: false });
  });
});
