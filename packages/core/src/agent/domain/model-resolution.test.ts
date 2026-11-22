import { describe, expect, it } from "@rstest/core";
import type { ModelAccountReport, ModelAccountReports } from "./model-account-report.js";
import type { CodexLogin } from "./model-login.js";
import {
  modelResolutionRequest,
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
    [available, "anthropic"],
    [limited, "openai"],
    [unauthorized, "openai"],
  ] as const)("uses ChatGPT credits after Claude capacity (%s)", (claude, providerId) => {
    const codex: ModelAccountReport = { ...available, requiresChatgptCredits: true };
    expect(resolveModel(large, facts({ reports: reports(codex, claude) }))).toMatchObject({
      ok: true,
      providerId,
    });
  });

  it("keeps explicit and provider-restricted GPT requests on allowed ChatGPT credits", () => {
    const given = facts({
      reports: reports({ ...available, requiresChatgptCredits: true }, available),
    });
    for (const request of [
      { kind: "exact", providerId: "openai", model: "gpt-6.1-sol" },
      { kind: "tier", tier: "large", providerId: "openai" },
    ] as const) {
      expect(resolveModel(request, given)).toEqual({
        ok: true,
        providerId: "openai",
        model: "gpt-6.1-sol",
      });
    }
  });

  it("keeps ChatGPT plan restrictions when credits cover the subscription limit", () => {
    const given = facts({
      reports: reports({ ...restricted, requiresChatgptCredits: true }, limited),
      tierModels: { openai: { large: "gpt-6.1-sol" } },
    });
    expect(resolveModel(large, given)).toEqual({
      ok: false,
      failure: { kind: "model_not_allowed", provider: "openai", model: "gpt-6.1-sol" },
    });
  });

  it("keeps available Codex subscription capacity ahead of Claude", () => {
    expect(resolveModel(large, facts({ reports: reports(available, available) }))).toMatchObject({
      ok: true,
      providerId: "openai",
    });
  });

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
      "Rome credits when no guardian account is logged in",
      large,
      facts({ reports: reports(unauthorized, unauthorized), logins: { openai: credits() } }),
      "openai",
      "gpt-6.1-sol",
    ],
    [
      "Terra on credits when the gateway does not serve Sol",
      large,
      facts({
        reports: reports(unauthorized, unauthorized),
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
      resolveModel(
        { kind: "exact", providerId: "openai", model: "gpt-6.1-sol", credits: true },
        given,
      ),
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
        reports: reports(unauthorized, unauthorized),
        logins: { openai: credits(["gpt-6.1-sol"]) },
      }),
      false,
    ],
  ])("fails as none usable when %s", (_name, given, allAtUsageLimit) => {
    const outcome = resolveModel({ kind: "tier", tier: "small" }, given);
    expect(outcome).toEqual({ ok: false, failure: { kind: "none_usable", allAtUsageLimit } });
  });
});

describe("resolveModel on the default provider", () => {
  it("runs a tier on the default provider, even when another comes first in the old order", () => {
    const given = facts({ reports: reports(available, available), defaultProvider: "anthropic" });
    expect(resolveModel(large, given)).toEqual({
      ok: true,
      providerId: "anthropic",
      model: "claude-opus-5-5[1m]",
    });
  });

  it("keeps the session's model while it is on the default provider", () => {
    const pin = { providerId: "anthropic" as const, model: "claude-sonnet-5-5" };
    const given = facts({ reports: reports(available, available), defaultProvider: "anthropic" });
    expect(resolveModel({ ...large, pin }, given)).toEqual({
      ok: true,
      providerId: "anthropic",
      model: "claude-sonnet-5-5",
    });
  });

  it("drops a pin on another provider than the default", () => {
    const pin = { providerId: "openai" as const, model: "gpt-6.1-sol" };
    const given = facts({ reports: reports(available, available), defaultProvider: "anthropic" });
    expect(resolveModel({ ...large, pin }, given)).toMatchObject({
      ok: true,
      providerId: "anthropic",
    });
  });

  it("fails when the default cannot run, and never moves to another provider", () => {
    const given = facts({ reports: reports(available, limited), defaultProvider: "anthropic" });
    expect(resolveModel(large, given)).toEqual({
      ok: false,
      failure: {
        kind: "provider_unavailable",
        provider: "anthropic",
        availability: "usage_limit_reached",
        usageLimitUntil: "2026-11-07T12:00:00.000Z",
        followsDefault: true,
      },
    });
  });

  it("runs one ask on the provider an override names", () => {
    const given = facts({ reports: reports(available, limited), defaultProvider: "anthropic" });
    expect(resolveModel({ ...large, override: "openai" }, given)).toMatchObject({
      ok: true,
      providerId: "openai",
    });
  });

  it("runs Codex on Rome credits when they are the default", () => {
    const given = facts({
      reports: reports(unauthorized, available),
      logins: { openai: credits() },
      defaultProvider: "rome_credits",
    });
    expect(resolveModel(large, given)).toMatchObject({ ok: true, providerId: "openai" });
  });

  it("does not spend Rome credits for a chat that follows ChatGPT after its login went", () => {
    const given = facts({
      reports: reports(unauthorized, unauthorized),
      logins: { openai: credits() },
      defaultProvider: "openai",
    });
    expect(resolveModel(large, given)).toMatchObject({
      ok: false,
      failure: { kind: "provider_unavailable", provider: "openai", availability: "unauthorized" },
    });
    // An exact model the chat was kept on is no different.
    expect(
      resolveModel({ kind: "exact", providerId: "openai", model: "gpt-6.1-sol" }, given),
    ).toMatchObject({ ok: false, failure: { kind: "provider_unavailable" } });
  });

  it("spends Rome credits for an ask whose chat was moved onto them", () => {
    const given = facts({
      reports: reports(unauthorized, unauthorized),
      logins: { openai: credits() },
      defaultProvider: "openai",
    });
    expect(
      resolveModel(
        { kind: "exact", providerId: "openai", model: "gpt-6.1-sol", credits: true },
        given,
      ),
    ).toMatchObject({ ok: true, providerId: "openai" });
  });

  it("spends Rome credits with no default set only while no AI account is logged in", () => {
    const exact = { kind: "exact", providerId: "openai", model: "gpt-6.1-sol" } as const;
    const claudeIn = facts({
      reports: reports(unauthorized, available),
      logins: { openai: credits() },
    });
    expect(resolveModel(exact, claudeIn)).toMatchObject({
      ok: false,
      failure: { kind: "provider_unavailable", provider: "openai" },
    });
    const noneIn = facts({
      reports: reports(unauthorized, unauthorized),
      logins: { openai: credits() },
    });
    expect(resolveModel(exact, noneIn)).toMatchObject({ ok: true, providerId: "openai" });
  });

  it("runs a chat on Rome credits on Codex, at the strength of the model it keeps", () => {
    expect(
      modelResolutionRequest("claude-opus-5-5", undefined, { tier: "large" }, true),
    ).toMatchObject({ kind: "exact", providerId: "openai", credits: true });
    expect(modelResolutionRequest(undefined, undefined, { tier: "large" }, true)).toEqual({
      kind: "tier",
      tier: "large",
      override: "openai",
      credits: true,
    });
    expect(modelResolutionRequest("claude-opus-5-5", undefined, { tier: "large" })).toMatchObject({
      kind: "exact",
      providerId: "anthropic",
    });
  });

  it("runs every chat on Rome credits while they are the default, a kept one too", () => {
    const given = facts({
      reports: reports(unauthorized, unauthorized),
      logins: { openai: credits() },
      defaultProvider: "rome_credits",
    });
    const kept = { kind: "exact", providerId: "openai", model: "gpt-6.1-sol" } as const;
    expect(resolveModel(kept, given)).toMatchObject({ ok: true, providerId: "openai" });
    // Once a login replaced them as the default, the same ask reads the guardian's account.
    expect(resolveModel(kept, { ...given, defaultProvider: "openai" })).toMatchObject({
      ok: false,
      failure: { kind: "provider_unavailable", provider: "openai" },
    });
  });

  it("runs a chat on Rome credits on the served model of its strength", () => {
    const given = facts({
      reports: reports(unauthorized, unauthorized),
      logins: { openai: credits(["gpt-6-luna", "gpt-5.6-terra"]) },
    });
    expect(
      resolveModel(
        { kind: "exact", providerId: "openai", model: "gpt-6-astra", credits: true },
        given,
      ),
    ).toEqual({ ok: true, providerId: "openai", model: "gpt-5.6-terra" });
  });

  it("finds none usable with no default and nothing signed in", () => {
    const given = facts({ reports: reports(unauthorized, unauthorized) });
    expect(resolveModel(large, given)).toMatchObject({
      ok: false,
      failure: { kind: "none_usable" },
    });
  });
});

describe("an unchecked move keeps every existing chat: a held session", () => {
  const heldOn = (
    provider: "anthropic" | "openai",
    selection?: Parameters<typeof modelResolutionRequest>[0],
    pin?: { providerId: "anthropic" | "openai"; model: string },
  ) => modelResolutionRequest(selection, pin, { tier: "large" }, true, provider);

  it("runs its tier on the provider it was held on, not on the default", () => {
    expect(
      resolveModel(
        heldOn("anthropic"),
        facts({ reports: reports(available, available), defaultProvider: "openai" }),
      ),
    ).toMatchObject({ ok: true, providerId: "anthropic" });
  });

  it("keeps the model it last ran there", () => {
    const pin = { providerId: "anthropic" as const, model: "claude-sonnet-5-5" };
    expect(
      resolveModel(
        heldOn("anthropic", undefined, pin),
        facts({ reports: reports(available, available), defaultProvider: "openai" }),
      ),
    ).toEqual({ ok: true, providerId: "anthropic", model: "claude-sonnet-5-5" });
  });

  it("never spends Rome credits: a held ChatGPT chat shows its own account's card", () => {
    expect(
      resolveModel(
        heldOn("openai", "gpt-6-1-sol"),
        facts({
          reports: reports(unauthorized, unauthorized),
          logins: { openai: credits() },
          defaultProvider: "rome_credits",
        }),
      ),
    ).toMatchObject({
      ok: false,
      failure: { kind: "provider_unavailable", provider: "openai", availability: "unauthorized" },
    });
  });

  it("a held Claude chat shows Claude's card while Rome credits are the default", () => {
    expect(
      resolveModel(
        heldOn("anthropic"),
        facts({
          reports: reports(unauthorized, unauthorized),
          logins: { openai: credits() },
          defaultProvider: "rome_credits",
        }),
      ),
    ).toMatchObject({ ok: false, failure: { provider: "anthropic" } });
  });

  it("keeps a held chat with a provider-restricted agent on its own account under a credits default", () => {
    const ask = modelResolutionRequest(
      "gpt-6-1-sol",
      undefined,
      { tier: "large", providerId: "openai" },
      true,
      "openai",
    );
    expect(ask).toMatchObject({ kind: "exact", providerId: "openai", ownAccount: true });
    expect(ask).not.toHaveProperty("credits");
    expect(
      resolveModel(
        ask,
        facts({
          reports: reports(unauthorized, unauthorized),
          logins: { openai: credits() },
          defaultProvider: "rome_credits",
        }),
      ),
    ).toMatchObject({ ok: false, failure: { provider: "openai", availability: "unauthorized" } });
  });

  it("leaves an agent restricted to a provider where its agent put it", () => {
    expect(
      modelResolutionRequest(
        undefined,
        undefined,
        { tier: "large", providerId: "openai" },
        false,
        "anthropic",
      ),
    ).toEqual({ kind: "tier", tier: "large", providerId: "openai", ownAccount: true });
  });
});
