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

  it("the default changes on a logout: to the other login, an expired one included", () => {
    expect(
      reconciledDefault("openai", { anthropic: true, openai: false, rome_credits: false }, null),
    ).toEqual({ provider: "anthropic", moved: true });
  });

  it("the default changes on the last logout: to Rome credits, when they can run", () => {
    expect(
      reconciledDefault("anthropic", { anthropic: false, openai: false, rome_credits: true }, null),
    ).toEqual({ provider: "rome_credits", moved: true });
  });

  it("gives Rome credits up to the first login without a note", () => {
    expect(
      reconciledDefault(
        "rome_credits",
        { anthropic: false, openai: true, rome_credits: false },
        null,
      ),
    ).toEqual({ provider: "openai", moved: false });
  });

  it("counts Rome credits only while no AI account is logged in", () => {
    const expired: ModelAccountReport = { state: "expired", account: { loggedIn: false } };
    expect(signedInProviders({ anthropic: out, openai: out }, true).rome_credits).toBe(true);
    expect(signedInProviders({ anthropic: expired, openai: out }, true).rome_credits).toBe(false);
    expect(signedInProviders({ anthropic: out, openai: limited }, true).rome_credits).toBe(false);
    expect(signedInProviders({ anthropic: out, openai: out }, false).rome_credits).toBe(false);
  });

  it("keeps a removed default with none left", () => {
    const none = { anthropic: false, openai: false, rome_credits: false };
    expect(reconciledDefault("openai", none, null)).toEqual({ provider: "openai", moved: false });
  });
});
