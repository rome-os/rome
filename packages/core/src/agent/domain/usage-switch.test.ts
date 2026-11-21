import { expect, it } from "@rstest/core";
import type { ModelAccountReports, ModelAccountReport } from "./model-account-report.js";
import { sameProviderTarget } from "./usage-switch.js";

const FRONTIER_DENIED = ["gpt-6.1-sol", "gpt-6-luna"];

function available(account: ModelAccountReport["account"] = { loggedIn: true }) {
  return { state: "available", account } as const satisfies ModelAccountReport;
}

function atLimit(account: ModelAccountReport["account"] = { loggedIn: true }) {
  return {
    state: "usage_limit_reached",
    usageLimitUntil: new Date(Date.now() + 3_600_000).toISOString(),
    account,
  } as const satisfies ModelAccountReport;
}

it("does not move a model onto ChatGPT credits", () => {
  const raw: ModelAccountReports = { openai: { ...available(), requiresChatgptCredits: true } };
  expect(sameProviderTarget(raw, "openai", "gpt-6.1-sol")).toBeNull();
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
  const raw: ModelAccountReports = { anthropic: available(), openai: available() };
  expect(sameProviderTarget(raw, provider, model)?.selectionId).toBe(target);
});

it("requires same-provider availability and model access", () => {
  const raw: ModelAccountReports = {
    anthropic: available(),
    openai: available({ loggedIn: true, modelsDenied: FRONTIER_DENIED }),
  };
  expect(sameProviderTarget(raw, "openai", "gpt-5.6-terra")).toBeNull();
  expect(sameProviderTarget(raw, "openai", "gpt-6.1-sol")?.selectionId).toBe("gpt-5-6-terra");
  for (const claude of [
    { state: "unauthorized", account: { loggedIn: false } },
    { state: "expired", account: { loggedIn: false, needsReauth: true } },
    atLimit(),
    available({ loggedIn: true, usageLimited: false }),
  ] satisfies ModelAccountReport[]) {
    expect(
      sameProviderTarget({ ...raw, anthropic: claude }, "anthropic", "claude-sonnet"),
    ).toBeNull();
  }
});
