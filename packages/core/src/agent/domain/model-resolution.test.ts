import { describe, expect, it } from "@rstest/core";
import type { ModelAccountReport, ModelAccountReports } from "./model-account-report.js";
import type { CodexLogin } from "./model-login.js";
import {
  type ModelResolutionFacts,
  type ModelResolutionRequest,
  resolveModel,
} from "./model-resolution.js";

const available: ModelAccountReport = {
  state: "available",
  account: { loggedIn: true, usageLimited: false },
};
const unauthorized: ModelAccountReport = {
  state: "unauthorized",
  account: { loggedIn: false, usageLimited: false },
};
const limited: ModelAccountReport = {
  state: "usage_limit_reached",
  usageLimitUntil: "2026-11-07T12:00:00.000Z",
  account: { loggedIn: true, usageLimited: true },
};
const restricted: ModelAccountReport = {
  ...available,
  account: { ...available.account, modelsDenied: ["gpt-6.1-sol", "gpt-6-luna"] },
};
const credits = (modelsServed: readonly string[] | null = null): CodexLogin => ({
  kind: "rome_credits",
  credentialId: "c",
  modelsServed,
});

const facts = (over: Partial<ModelResolutionFacts> = {}): ModelResolutionFacts => ({
  providers: ["anthropic", "openai"],
  reports: {},
  logins: {},
  ...over,
});
const large: ModelResolutionRequest = { kind: "tier", tier: "large" };
const small: ModelResolutionRequest = { kind: "tier", tier: "small" };
const reports = (
  openai?: ModelAccountReport,
  anthropic?: ModelAccountReport,
): ModelAccountReports => ({
  ...(openai ? { openai } : {}),
  ...(anthropic ? { anthropic } : {}),
});

describe("resolveModel", () => {
  it.each([
    ["Codex first when its account is usable", large, facts(), "openai", "gpt-6.1-sol"],
    ["Luna for a small tier", small, facts(), "openai", "gpt-6-luna"],
    [
      "Terra when the plan withholds Sol",
      large,
      facts({ reports: reports(restricted) }),
      "openai",
      "gpt-5.6-terra",
    ],
    [
      "Claude when Codex is logged out",
      large,
      facts({ reports: reports(unauthorized) }),
      "anthropic",
      "claude-opus-5-5[1m]",
    ],
    [
      "Claude before Rome credits",
      large,
      facts({ reports: reports(unauthorized), logins: { openai: credits() } }),
      "anthropic",
      "claude-opus-5-5[1m]",
    ],
    [
      "Rome credits when no guardian account can serve",
      large,
      facts({ reports: reports(unauthorized, limited), logins: { openai: credits() } }),
      "openai",
      "gpt-6.1-sol",
    ],
    [
      "Terra on credits when the gateway does not serve Sol",
      large,
      facts({
        reports: reports(unauthorized, limited),
        logins: { openai: credits(["gpt-5.6-terra"]) },
      }),
      "openai",
      "gpt-5.6-terra",
    ],
    [
      "the guardian's tier model",
      large,
      facts({ tierModels: { openai: { large: "gpt-5.3-codex" } } }),
      "openai",
      "gpt-5.3-codex",
    ],
    ["the mock last", large, facts({ providers: ["mock"] }), "mock", "claude-opus-5-5[1m]"],
  ])("resolves a tier to %s", (_name, request, given, providerId, model) => {
    expect(resolveModel(request, given)).toEqual({ ok: true, providerId, model });
  });

  it("does not limit a model on Rome credits by the guardian's plan", () => {
    const given = facts({ reports: reports(restricted), logins: { openai: credits() } });
    expect(
      resolveModel({ kind: "exact", providerId: "openai", model: "gpt-6.1-sol" }, given),
    ).toMatchObject({ ok: true });
  });

  it("allows a served model by exact name, without the legacy effort suffix", () => {
    const given = facts({ logins: { openai: credits(["gpt-6.1-sol"]) } });
    expect(
      resolveModel({ kind: "exact", providerId: "openai", model: "gpt-6.1-sol:high" }, given),
    ).toMatchObject({ ok: true });
  });

  it("fails an exact ask on a logged-out provider, never substituting", () => {
    const given = facts({ reports: reports(available, unauthorized) });
    expect(
      resolveModel({ kind: "exact", providerId: "anthropic", model: "claude-sonnet-5-5" }, given),
    ).toEqual({
      ok: false,
      failure: {
        kind: "provider_unavailable",
        provider: "anthropic",
        availability: "unauthorized",
      },
    });
  });

  it("carries when a usage limit ends", () => {
    const given = facts({ reports: reports(limited) });
    expect(
      resolveModel({ kind: "exact", providerId: "openai", model: "gpt-6.1-sol" }, given),
    ).toEqual({
      ok: false,
      failure: {
        kind: "provider_unavailable",
        provider: "openai",
        availability: "usage_limit_reached",
        usageLimitUntil: "2026-11-07T12:00:00.000Z",
      },
    });
  });

  it("fails a tier whose first usable provider's login does not allow its model", () => {
    const given = facts({
      reports: reports(restricted),
      tierModels: { openai: { large: "gpt-6.1-sol" } },
    });
    expect(resolveModel(large, given)).toEqual({
      ok: false,
      failure: { kind: "model_not_allowed", provider: "openai", model: "gpt-6.1-sol" },
    });
  });

  it("keeps a tier restricted to Codex on the guardian's account while on Rome credits", () => {
    const given = facts({ reports: reports(unauthorized), logins: { openai: credits() } });
    expect(resolveModel({ kind: "tier", tier: "large", providerId: "openai" }, given)).toEqual({
      ok: false,
      failure: { kind: "provider_unavailable", provider: "openai", availability: "unauthorized" },
    });
  });

  it("does not spend credits on a tier the gateway cannot serve", () => {
    const given = facts({
      reports: reports(unauthorized, unauthorized),
      logins: { openai: credits(["gpt-6.1-sol"]) },
    });
    expect(resolveModel(small, given)).toEqual({
      ok: false,
      failure: { kind: "none_usable", allAtUsageLimit: false },
    });
  });

  it.each([
    [
      "every connected provider is at its limit",
      facts({ reports: reports(limited, limited) }),
      true,
    ],
    ["no provider is connected", facts({ reports: reports(unauthorized, unauthorized) }), false],
    [
      "Rome credits count as connected and not limited",
      facts({
        reports: reports(unauthorized, limited),
        logins: { openai: credits(["gpt-6.1-sol"]) },
      }),
      false,
    ],
  ])("fails as none usable when %s", (_name, given, allAtUsageLimit) => {
    const outcome = resolveModel({ kind: "tier", tier: "small" }, given);
    expect(outcome).toEqual({ ok: false, failure: { kind: "none_usable", allAtUsageLimit } });
  });
});
