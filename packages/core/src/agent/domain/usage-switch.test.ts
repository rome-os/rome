import { expect, it } from "@rstest/core";
import type { ModelAvailabilityState, ProviderAvailability } from "./provider-availability.js";
import { sameProviderTarget, soleProviderAtUsageLimit, usageSwitchTarget } from "./usage-switch.js";

const TERRA_ONLY = ["gpt-5.6-terra"];

function available(account: ProviderAvailability["account"] = { loggedIn: true }) {
  return { state: "available", account } as const satisfies ProviderAvailability;
}

function atLimit(account: ProviderAvailability["account"] = { loggedIn: true }) {
  return {
    state: "usage_limit_reached",
    usageLimitUntil: new Date(Date.now() + 3_600_000).toISOString(),
    account,
  } as const satisfies ProviderAvailability;
}

const state = (): ModelAvailabilityState => ({
  anthropic: atLimit(),
  openai: available(),
});

it("keeps Concierge's Luna then Terra and Sonnet choices", () => {
  const raw = state();
  expect(soleProviderAtUsageLimit(raw)).toBe("anthropic");
  expect(usageSwitchTarget(raw, "anthropic")?.selectionId).toBe("gpt-6-luna");
  raw.openai = available({ loggedIn: true, models: TERRA_ONLY });
  expect(usageSwitchTarget(raw, "anthropic")?.selectionId).toBe("gpt-5-6-terra");
  raw.openai = atLimit();
  expect(soleProviderAtUsageLimit(raw)).toBeNull();
  expect(usageSwitchTarget(raw, "anthropic")).toBeNull();
  raw.anthropic = available();
  expect(soleProviderAtUsageLimit(raw)).toBe("openai");
  expect(usageSwitchTarget(raw, "openai")?.selectionId).toBe("claude-sonnet");
  raw.openai = available();
  expect(soleProviderAtUsageLimit(raw)).toBeNull();
  expect(usageSwitchTarget(raw, "openai")).toBeNull();
});

it.each([
  "openai",
  "anthropic",
] as const)("requires an available subscription opposite %s", (from) => {
  const other = from === "openai" ? "anthropic" : "openai";
  for (const target of [
    { state: "unauthorized", account: { loggedIn: false } },
    undefined,
    { state: "expired", account: { loggedIn: false, needsReauth: true } },
    atLimit(),
    available({ loggedIn: true, usageLimited: false }),
  ] satisfies Array<ProviderAvailability | undefined>) {
    const changed: ModelAvailabilityState = { [from]: atLimit(), [other]: target };
    expect(usageSwitchTarget(changed, from)).toBeNull();
  }
});

it("excludes Rome credits by reading raw unauthorized Codex, not resolver availability", () => {
  const raw = state();
  raw.openai = { state: "unauthorized", account: { loggedIn: false } };
  expect(usageSwitchTarget(raw, "anthropic")).toBeNull();
});

it("switches on a failed turn before the limit is read, from a subscription only", () => {
  const raw: ModelAvailabilityState = { anthropic: available(), openai: available() };
  expect(usageSwitchTarget(raw, "anthropic")).toBeNull();
  expect(usageSwitchTarget(raw, "anthropic", true)?.provider).toBe("openai");
  raw.anthropic = available({ loggedIn: true, usageLimited: false });
  expect(usageSwitchTarget(raw, "anthropic", true)).toBeNull();
});

it.each([
  ["anthropic", "claude-sonnet-5-5", "claude-opus-5-5"],
  ["anthropic", "claude-opus-5-5[1m]", "claude-sonnet"],
  ["anthropic", "claude-fable-5-1[1m]", "claude-sonnet"],
  ["anthropic", "claude-haiku-5-5", "claude-sonnet"],
  ["openai", "gpt-6-luna", "gpt-5-6-terra"],
  ["openai", "gpt-5.6-terra", "gpt-6-luna"],
  ["openai", "gpt-6.1-sol", "gpt-6-luna"],
] as const)("keeps %s's thread from %s on %s", (provider, model, target) => {
  const raw: ModelAvailabilityState = { anthropic: available(), openai: available() };
  expect(sameProviderTarget(raw, provider, model)?.selectionId).toBe(target);
});

it("requires same-provider availability and model access", () => {
  const raw: ModelAvailabilityState = {
    anthropic: available(),
    openai: available({ loggedIn: true, models: TERRA_ONLY }),
  };
  expect(sameProviderTarget(raw, "openai", "gpt-5.6-terra")).toBeNull();
  expect(sameProviderTarget(raw, "openai", "gpt-6.1-sol")?.selectionId).toBe("gpt-5-6-terra");
  for (const claude of [
    { state: "unauthorized", account: { loggedIn: false } },
    { state: "expired", account: { loggedIn: false, needsReauth: true } },
    atLimit(),
    available({ loggedIn: true, usageLimited: false }),
  ] satisfies ProviderAvailability[]) {
    expect(
      sameProviderTarget({ ...raw, anthropic: claude }, "anthropic", "claude-sonnet"),
    ).toBeNull();
  }
});
