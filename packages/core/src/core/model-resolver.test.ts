import { describe, expect, it, rs } from "@rstest/core";
import type { ModelProvider } from "./agent-runner.js";
import {
  ClaudeAccount,
  createModelResolver,
  createTierModelsSetting,
  MODEL_SELECTIONS,
  TIER_MODEL_MAPPINGS_SETTING_KEY,
  type ModelSelectionId,
  createModelAccounts,
  type ModelAccount,
  type ModelAccountUsage,
  type ModelAccountReports,
} from "../agent/index.js";
import { reportOf, fakeAccounts, loginsOn, RESTRICTED_PLAN } from "../test/kit/model-accounts.js";

const codex = { id: "openai" } as ModelProvider;

/** A model the guardian picked, as the exact ask it becomes. */
function selected(id: ModelSelectionId) {
  const { providerId, model } = MODEL_SELECTIONS[id];
  return { kind: "exact" as const, providerId, model };
}
const claude = { id: "anthropic" } as ModelProvider;

function resolver(
  overrides: Partial<ModelAccountReports> = {},
  settings: { tierModelMappings?: unknown } = {},
  usingRomeCredits = false,
  servedModels: readonly string[] | null = null,
) {
  const value: ModelAccountReports = {
    openai: reportOf("available"),
    anthropic: reportOf("available"),
    ...overrides,
  };
  return createModelResolver({
    accounts: fakeAccounts(() => value),
    providers: [claude, codex],
    tierModels: createTierModelsSetting({
      get: async <T = unknown>(key: string): Promise<T | null> =>
        (key === TIER_MODEL_MAPPINGS_SETTING_KEY
          ? (settings.tierModelMappings ?? null)
          : null) as T | null,
    }),
    codexLogins: loginsOn(usingRomeCredits, servedModels),
  });
}

describe("ModelResolver", () => {
  it("maps Codex tiers through Sol and Luna", async () => {
    await expect(resolver().resolve({ kind: "tier", tier: "large" })).resolves.toMatchObject({
      modelProvider: codex,
      model: "gpt-6.1-sol",
    });
    await expect(resolver().resolve({ kind: "tier", tier: "medium" })).resolves.toMatchObject({
      model: "gpt-6.1-sol",
    });
    await expect(resolver().resolve({ kind: "tier", tier: "small" })).resolves.toMatchObject({
      model: "gpt-6-luna",
    });
  });

  it("resolves Codex models the same way on Rome credits while the served list is unknown", async () => {
    const loggedOut = {
      openai: reportOf("unauthorized"),
      anthropic: reportOf("unauthorized"),
    };
    const r = resolver(
      loggedOut,
      { tierModelMappings: { openai: { medium: "gpt-6-astra" } } },
      true,
    );
    await expect(r.resolve({ kind: "tier", tier: "large" })).resolves.toMatchObject({
      modelProvider: codex,
      model: "gpt-6.1-sol",
    });
    await expect(r.resolve({ kind: "tier", tier: "medium" })).resolves.toMatchObject({
      model: "gpt-6-astra",
    });
    await expect(
      r.resolve({ kind: "exact", providerId: "openai", model: "gpt-6.1-sol" }),
    ).resolves.toMatchObject({ modelProvider: codex, model: "gpt-6.1-sol" });
  });

  describe("on Rome credits with a reported served list", () => {
    const loggedOut = {
      openai: reportOf("unauthorized"),
      anthropic: reportOf("unauthorized"),
    };

    it("falls a tier back to a model the gateway serves", async () => {
      const r = resolver(loggedOut, {}, true, ["gpt-5.6-terra", "gpt-6-luna"]);
      await expect(r.resolve({ kind: "tier", tier: "large" })).resolves.toMatchObject({
        modelProvider: codex,
        model: "gpt-5.6-terra",
      });
      await expect(r.resolve({ kind: "tier", tier: "medium" })).resolves.toMatchObject({
        model: "gpt-5.6-terra",
      });
      await expect(r.resolve({ kind: "tier", tier: "small" })).resolves.toMatchObject({
        model: "gpt-6-luna",
      });
    });

    it("uses Sol and Luna when the gateway serves them", async () => {
      const r = resolver(loggedOut, {}, true, ["gpt-6.1-sol", "gpt-6-luna", "gpt-5.6-terra"]);
      await expect(r.resolve({ kind: "tier", tier: "large" })).resolves.toMatchObject({
        model: "gpt-6.1-sol",
      });
      await expect(r.resolve({ kind: "tier", tier: "small" })).resolves.toMatchObject({
        model: "gpt-6-luna",
      });
    });

    it("does not spend credits on a tier the gateway cannot serve", async () => {
      const r = resolver(loggedOut, {}, true, ["gpt-6.1-sol"]);
      await expect(r.resolve({ kind: "tier", tier: "large" })).resolves.toMatchObject({
        model: "gpt-6.1-sol",
      });
      await expect(r.resolve({ kind: "tier", tier: "small" })).rejects.toMatchObject({
        code: "no_model_provider_available",
      });
      await expect(
        resolver(loggedOut, {}, true, []).resolve({ kind: "tier", tier: "large" }),
      ).rejects.toMatchObject({ code: "no_model_provider_available" });
    });

    it("prefers a connected Claude login over a tier the gateway cannot serve", async () => {
      const r = resolver({ ...loggedOut, anthropic: reportOf("available") }, {}, true, []);
      await expect(r.resolve({ kind: "tier", tier: "small" })).resolves.toMatchObject({
        modelProvider: claude,
      });
    });

    it.each([
      { kind: "exact" as const, providerId: "openai" as const, model: "gpt-6.1-sol" },
      { kind: "exact" as const, providerId: "openai" as const, model: "gpt-6-astra" },
      { kind: "exact" as const, providerId: "openai" as const, model: "gpt-6.1-sol:high" },
      selected("gpt-6-1-sol"),
    ])("fails an unserved pin or selection with model_unavailable: %o", async (request) => {
      const r = resolver(loggedOut, {}, true, ["gpt-5.6-terra"]);
      await expect(r.resolve(request)).rejects.toMatchObject({
        code: "model_unavailable",
        provider: "openai",
        reason: "model_access_denied",
      });
    });

    it("runs a served pin by the exact name Codex sends", async () => {
      const r = resolver(loggedOut, {}, true, ["gpt-6.1-sol"]);
      await expect(
        r.resolve({ kind: "exact", providerId: "openai", model: "gpt-6.1-sol:high" }),
      ).resolves.toMatchObject({ modelProvider: codex, model: "gpt-6.1-sol:high" });
      await expect(
        r.resolve({ kind: "exact", providerId: "openai", model: "gpt-6.1-sol-2026-01-01" }),
      ).rejects.toMatchObject({ code: "model_unavailable" });
    });

    it("fails a configured tier model the gateway does not serve", async () => {
      const r = resolver(
        loggedOut,
        { tierModelMappings: { openai: { medium: "gpt-6-astra" } } },
        true,
        ["gpt-5.6-terra"],
      );
      await expect(r.resolve({ kind: "tier", tier: "medium" })).rejects.toMatchObject({
        code: "model_unavailable",
      });
    });

    it("resolves at once when the gateway has not said, and the gateway refuses what it does not serve", async () => {
      const r = resolver(
        { openai: reportOf("unauthorized"), anthropic: reportOf("unauthorized") },
        {},
        true,
        null,
      );
      await expect(r.resolve({ kind: "tier", tier: "large" })).resolves.toMatchObject({
        modelProvider: codex,
        model: "gpt-6.1-sol",
      });
    });

    it("leaves a turn Claude serves to Claude on Rome credits", async () => {
      const value: ModelAccountReports = {
        openai: reportOf("unauthorized"),
        anthropic: reportOf("available"),
      };
      const r = createModelResolver({
        accounts: fakeAccounts(() => value),
        providers: [claude, codex],
        codexLogins: loginsOn(true, null),
      });
      await expect(r.resolve({ kind: "tier", tier: "large" })).resolves.toMatchObject({
        modelProvider: claude,
      });
      await expect(
        r.resolve({ kind: "exact", providerId: "anthropic", model: "claude-sonnet-5-5" }),
      ).resolves.toMatchObject({ modelProvider: claude });
    });

    it("ignores the served list on the guardian's own login", async () => {
      const r = resolver({}, {}, false, []);
      await expect(r.resolve({ kind: "tier", tier: "large" })).resolves.toMatchObject({
        modelProvider: codex,
        model: "gpt-6.1-sol",
      });
      await expect(
        r.resolve({ kind: "exact", providerId: "openai", model: "gpt-6-astra" }),
      ).resolves.toMatchObject({ model: "gpt-6-astra" });
    });
  });

  it("keeps a Codex provider pin by tier on the ChatGPT login while on Rome credits", async () => {
    const r = resolver(
      {
        openai: reportOf("unauthorized"),
        anthropic: reportOf("unauthorized"),
      },
      {},
      true,
    );
    await expect(
      r.resolve({ kind: "tier", tier: "small", providerId: "openai" }),
    ).rejects.toMatchObject({
      code: "model_provider_unavailable",
      provider: "openai",
      reason: "not_logged_in",
    });
  });

  it("fails a tier with no usable provider when credits do not pay", async () => {
    const state: ModelAccountReports = {
      openai: reportOf("unauthorized"),
      anthropic: reportOf("unauthorized"),
    };
    const r = createModelResolver({
      // Production returns a fresh copy on every read.
      accounts: { read: () => structuredClone(state), refresh: async () => {} },
      providers: [claude, codex],
      codexLogins: loginsOn(false),
    });
    await expect(r.resolve({ kind: "tier", tier: "large" })).rejects.toMatchObject({
      code: "no_model_provider_available",
    });
  });

  it("prefers a connected Claude login over spending Rome credits", async () => {
    const r = resolver(
      {
        openai: reportOf("unauthorized"),
        anthropic: reportOf("available"),
      },
      {},
      true,
    );
    await expect(r.resolve({ kind: "tier", tier: "large" })).resolves.toMatchObject({
      modelProvider: claude,
    });
  });

  it("uses the login and provider state that are current after settings reads", async () => {
    let releaseSettings!: () => void;
    const settingsReady = new Promise<void>((resolve) => {
      releaseSettings = resolve;
    });
    let settingsRead!: () => void;
    const settingsStarted = new Promise<void>((resolve) => {
      settingsRead = resolve;
    });
    let usingRomeCredits = false;
    const state: ModelAccountReports = {
      openai: reportOf("available"),
      anthropic: reportOf("unauthorized"),
    };
    const r = createModelResolver({
      accounts: fakeAccounts(() => state),
      providers: [claude, codex],
      tierModels: createTierModelsSetting({
        get: async () => {
          settingsRead();
          await settingsReady;
          return null;
        },
      }),
      codexLogins: { login: () => loginsOn(usingRomeCredits).login() },
    });

    const resolution = r.resolve({ kind: "tier", tier: "large" });
    await settingsStarted;
    state.openai = reportOf("unauthorized");
    state.anthropic = reportOf("available");
    usingRomeCredits = true;
    releaseSettings();

    await expect(resolution).resolves.toMatchObject({ modelProvider: claude });
  });

  it("falls back from unavailable Sol/Luna to Terra on every tier", async () => {
    const r = resolver({
      openai: reportOf("available", { ...RESTRICTED_PLAN }),
    });
    await expect(r.resolve({ kind: "tier", tier: "large" })).resolves.toMatchObject({
      model: "gpt-5.6-terra",
    });
    await expect(r.resolve({ kind: "tier", tier: "medium" })).resolves.toMatchObject({
      model: "gpt-5.6-terra",
    });
    await expect(r.resolve({ kind: "tier", tier: "small" })).resolves.toMatchObject({
      model: "gpt-5.6-terra",
    });
  });

  it("uses a configured model ID for each provider and tier", async () => {
    const r = resolver(
      {},
      {
        tierModelMappings: {
          openai: { large: "custom-codex", medium: "custom-codex-medium" },
          anthropic: { small: "custom-claude" },
        },
      },
    );

    await expect(r.resolve({ kind: "tier", tier: "large" })).resolves.toMatchObject({
      modelProvider: codex,
      model: "custom-codex",
    });
    await expect(
      r.resolve({ kind: "tier", tier: "medium", providerId: "openai" }),
    ).resolves.toMatchObject({
      modelProvider: codex,
      model: "custom-codex-medium",
    });
    await expect(
      r.resolve({ kind: "tier", tier: "small", providerId: "anthropic" }),
    ).resolves.toMatchObject({
      modelProvider: claude,
      model: "custom-claude",
    });
  });

  it("falls back to the built-in model when a configured mapping is invalid or absent", async () => {
    const r = resolver(
      {},
      {
        tierModelMappings: {
          openai: { large: "   ", medium: 12 },
          anthropic: "not-an-object",
        },
      },
    );

    await expect(r.resolve({ kind: "tier", tier: "large" })).resolves.toMatchObject({
      model: "gpt-6.1-sol",
    });
    await expect(
      r.resolve({ kind: "tier", tier: "medium", providerId: "anthropic" }),
    ).resolves.toMatchObject({
      model: "claude-sonnet-5-5",
    });
  });

  it("prefers Codex, then Claude, and skips definite logout/quota", async () => {
    await expect(resolver().resolve({ kind: "tier", tier: "large" })).resolves.toMatchObject({
      modelProvider: codex,
    });
    await expect(
      resolver({
        openai: reportOf("unauthorized"),
      }).resolve({ kind: "tier", tier: "large" }),
    ).resolves.toMatchObject({ modelProvider: claude });
    await expect(
      resolver({
        openai: reportOf("usage_limit_reached"),
      }).resolve({ kind: "tier", tier: "large" }),
    ).resolves.toMatchObject({ modelProvider: claude });
  });

  it("keeps Codex preferred for a large tier when Claude large is mapped", async () => {
    const r = resolver({}, { tierModelMappings: { anthropic: { large: "claude-fable-5-1[1m]" } } });

    await expect(r.resolve({ kind: "tier", tier: "large" })).resolves.toMatchObject({
      modelProvider: codex,
      model: "gpt-6.1-sol",
    });
    await expect(
      r.resolve({ kind: "tier", tier: "large", providerId: "anthropic" }),
    ).resolves.toMatchObject({
      modelProvider: claude,
      model: "claude-fable-5-1[1m]",
    });
  });

  it("resolves a tier on the requested provider", async () => {
    await expect(
      resolver().resolve({ kind: "tier", tier: "large", providerId: "anthropic" }),
    ).resolves.toMatchObject({
      modelProvider: claude,
      model: "claude-opus-5-5[1m]",
    });
    await expect(
      resolver().resolve({ kind: "tier", tier: "small", providerId: "anthropic" }),
    ).resolves.toMatchObject({
      modelProvider: claude,
      model: "claude-haiku-5-5",
    });
  });

  it("fails closed instead of falling back when the requested provider is unavailable", async () => {
    // The Codex pin used by provider-dependent agents (e.g. image_gen): small
    // tier resolves on Codex, and a disconnected Codex is an error, never a
    // silent fallback to a provider without the pinned capability.
    await expect(
      resolver().resolve({ kind: "tier", tier: "small", providerId: "openai" }),
    ).resolves.toMatchObject({
      modelProvider: codex,
      model: "gpt-6-luna",
    });
    await expect(
      resolver({
        openai: reportOf("unauthorized"),
      }).resolve({ kind: "tier", tier: "small", providerId: "openai" }),
    ).rejects.toMatchObject({
      message: "Selected model provider is unavailable: Codex (ChatGPT) is not signed in",
      code: "model_provider_unavailable",
      provider: "openai",
      reason: "not_logged_in",
    });
  });

  it("names the usage limit and when it ends for a pinned provider", async () => {
    // Summoned agents and apps receive only the message, so the cause has to
    // survive without the structured reason.
    await expect(
      resolver({
        openai: reportOf("usage_limit_reached", {}, "2026-10-21T14:59:00.000Z"),
      }).resolve({ kind: "tier", tier: "large", providerId: "openai" }),
    ).rejects.toMatchObject({
      message:
        "Selected model provider is unavailable: Codex (ChatGPT) has reached its usage limit until 2026-10-21T14:59:00.000Z",
      reason: "quota_exhausted",
    });
    await expect(
      resolver({
        openai: { state: "usage_limit_reached", account: { loggedIn: true } },
      }).resolve({ kind: "tier", tier: "large", providerId: "openai" }),
    ).rejects.toMatchObject({
      message:
        "Selected model provider is unavailable: Codex (ChatGPT) has reached its usage limit",
      reason: "quota_exhausted",
    });
  });

  it("resolves GPT-6.1 Sol selections and exact aliases with Sol access", async () => {
    await expect(
      resolver().resolve({ kind: "tier", tier: "large", providerId: "openai" }),
    ).resolves.toMatchObject({ modelProvider: codex, model: "gpt-6.1-sol" });
    await expect(resolver().resolve(selected("gpt-6-1-sol"))).resolves.toMatchObject({
      modelProvider: codex,
      model: "gpt-6.1-sol",
    });
    await expect(resolver().resolve(selected("gpt-6-sol"))).resolves.toMatchObject({
      modelProvider: codex,
      model: "gpt-6-sol",
    });

    const unavailable = resolver({
      openai: reportOf("available", { ...RESTRICTED_PLAN }),
    });
    await expect(unavailable.resolve(selected("gpt-6-1-sol"))).rejects.toMatchObject({
      code: "model_unavailable",
      reason: "model_access_denied",
    });

    for (const model of ["gpt-6.1-sol", "gpt-6.1-sol:high", "gpt-6.1-sol-2026-10-01:high"]) {
      await expect(
        resolver().resolve({ kind: "exact", providerId: "openai", model }),
      ).resolves.toMatchObject({ modelProvider: codex, model });
      await expect(
        unavailable.resolve({ kind: "exact", providerId: "openai", model }),
      ).rejects.toMatchObject({
        code: "model_unavailable",
        provider: "openai",
        reason: "model_access_denied",
      });
    }
  });

  it("keeps explicit Astra/Sol/Luna exact and never falls back", async () => {
    await expect(resolver().resolve(selected("gpt-6-astra"))).resolves.toMatchObject({
      modelProvider: codex,
      model: "gpt-6-astra",
    });
    await expect(resolver().resolve(selected("gpt-5-6-sol"))).resolves.toMatchObject({
      modelProvider: codex,
      model: "gpt-5.6-sol",
    });
    await expect(resolver().resolve(selected("gpt-5-6-luna"))).resolves.toMatchObject({
      modelProvider: codex,
      model: "gpt-5.6-luna",
    });

    const unavailable = resolver({
      openai: reportOf("available", { ...RESTRICTED_PLAN }),
    });
    await expect(unavailable.resolve(selected("gpt-5-6-sol"))).rejects.toThrow(
      "Selected model is unavailable",
    );
    await expect(unavailable.resolve(selected("gpt-6-astra"))).rejects.toThrow(
      "Selected model is unavailable",
    );
  });

  it("classifies an unavailable explicit provider and refreshes it asynchronously", async () => {
    const value: ModelAccountReports = {
      openai: reportOf("unauthorized"),
      anthropic: reportOf("available"),
    };
    let finishRefresh!: () => void;
    const refresh = rs.fn(
      () =>
        new Promise<void>((resolve) => {
          finishRefresh = () => resolve();
        }),
    );
    const r = createModelResolver({
      providers: [claude, codex],
      accounts: { read: () => value, refresh },
    });

    await expect(r.resolve(selected("gpt-5-6-sol"))).rejects.toMatchObject({
      code: "model_provider_unavailable",
      provider: "openai",
      reason: "not_logged_in",
    });
    expect(refresh).toHaveBeenCalledWith("openai");
    finishRefresh();
  });

  it("distinguishes quota exhaustion from a missing login", async () => {
    const value: ModelAccountReports = {
      openai: reportOf("usage_limit_reached"),
      anthropic: reportOf("available"),
    };
    const r = createModelResolver({
      providers: [claude, codex],
      accounts: fakeAccounts(() => value),
    });

    await expect(r.resolve(selected("gpt-5-6-sol"))).rejects.toMatchObject({
      code: "model_provider_unavailable",
      provider: "openai",
      reason: "quota_exhausted",
    });
  });

  it("reports quota exhaustion when every connected provider is exhausted", async () => {
    const r = resolver({
      openai: reportOf("usage_limit_reached"),
      anthropic: reportOf("usage_limit_reached"),
    });
    await expect(r.resolve({ kind: "tier", tier: "large" })).rejects.toMatchObject({
      message: "All connected model providers have reached their usage limits",
      code: "no_model_provider_available",
      reason: "quota_exhausted",
    });
  });

  it("keeps Claude API-key-backed providers available despite stale quota state", async () => {
    await expect(
      resolver({
        openai: reportOf("unauthorized"),
        anthropic: reportOf("available", {
          authMethod: "stored-compatible",
          usageLimited: false,
        }),
      }).resolve({ kind: "tier", tier: "large" }),
    ).resolves.toMatchObject({ modelProvider: claude });
  });

  it("returns exactly the requested provider/model for an exact request", async () => {
    // Tier resolution would prefer Codex (Sol); the exact request must win untouched.
    await expect(
      resolver().resolve({ kind: "exact", providerId: "anthropic", model: "claude-sonnet-5" }),
    ).resolves.toMatchObject({ modelProvider: claude, model: "claude-sonnet-5" });
    // Sol entitlement would upgrade a large tier to Sol; an exact Terra pin stays Terra.
    await expect(
      resolver().resolve({ kind: "exact", providerId: "openai", model: "gpt-5.6-terra" }),
    ).resolves.toMatchObject({ modelProvider: codex, model: "gpt-5.6-terra" });
  });

  it("runs an exact pin to a model no tier resolves to", async () => {
    await expect(
      resolver().resolve({ kind: "exact", providerId: "anthropic", model: "claude-fable-5-1[1m]" }),
    ).resolves.toMatchObject({ modelProvider: claude, model: "claude-fable-5-1[1m]" });
  });

  it("fails an exact request closed when its provider is logged out, and refreshes it", async () => {
    const value: ModelAccountReports = {
      openai: reportOf("unauthorized"),
      // The other provider is fully usable — an exact request must not substitute it.
      anthropic: reportOf("available"),
    };
    const refresh = rs.fn(async () => {});
    const r = createModelResolver({
      providers: [claude, codex],
      accounts: { read: () => value, refresh },
    });

    await expect(
      r.resolve({ kind: "exact", providerId: "openai", model: "gpt-5.6-terra" }),
    ).rejects.toMatchObject({
      code: "model_provider_unavailable",
      provider: "openai",
      reason: "not_logged_in",
    });
    expect(refresh).toHaveBeenCalledWith("openai");
  });

  it("fails an exact request closed on quota exhaustion", async () => {
    await expect(
      resolver({
        anthropic: reportOf("usage_limit_reached"),
      }).resolve({ kind: "exact", providerId: "anthropic", model: "claude-sonnet-5" }),
    ).rejects.toMatchObject({
      code: "model_provider_unavailable",
      provider: "anthropic",
      reason: "quota_exhausted",
    });
  });

  it("serves an exact Claude request once usage-derived exhaustion resets, even while usage probes fail", async () => {
    const now = Date.parse("2026-10-11T12:00:00.000Z");
    const resetsAt = new Date(now + 60 * 60 * 1000).toISOString();
    rs.useFakeTimers({ shouldAdvanceTime: false });
    rs.setSystemTime(now);
    try {
      const claudeUsage = rs.fn<() => Promise<ModelAccountUsage | null>>(async () => ({
        checkedAt: new Date().toISOString(),
        source: "test",
        error: "Claude usage request failed with HTTP 429",
      }));
      claudeUsage.mockResolvedValueOnce({
        checkedAt: new Date(now).toISOString(),
        source: "test",
        fiveHour: { usedPercent: 100, resetsAt },
      });
      const codexAccount: ModelAccount = {
        report: async () => ({ state: "unauthorized", account: { loggedIn: false } }),
        onChanged: () => () => {},
        close: () => {},
      };
      const claudeAccount = new ClaudeAccount({
        env: {},
        readCliStatus: async () => ({ loggedIn: true, authMethod: "oauth" }),
        readUsage: claudeUsage,
      });
      const accounts = createModelAccounts({
        accounts: { openai: codexAccount, anthropic: claudeAccount },
        startRefresh: false,
        refreshIntervalMs: null,
      });
      await accounts.refresh("anthropic");
      let failureRefresh: Promise<boolean> | undefined;
      const r = createModelResolver({
        providers: [claude, codex],
        accounts: {
          read: accounts.read,
          refresh: (provider) => (failureRefresh = accounts.refresh(provider)),
        },
      });
      const request = {
        kind: "exact" as const,
        providerId: "anthropic" as const,
        model: "claude-sonnet-5-5",
      };

      await expect(r.resolve(request)).rejects.toMatchObject({
        provider: "anthropic",
        reason: "quota_exhausted",
      });
      await failureRefresh;
      expect(claudeUsage).toHaveBeenCalledTimes(2);

      rs.setSystemTime(Date.parse(resetsAt));
      await expect(r.resolve(request)).resolves.toMatchObject({ modelProvider: claude });
      expect(claudeUsage).toHaveBeenCalledTimes(2);
    } finally {
      rs.useRealTimers();
    }
  });

  it("rejects a tier ask that also names a model at the type level", () => {
    type Request = Parameters<ReturnType<typeof resolver>["resolve"]>[0];
    // @ts-expect-error — a tier ask and an exact ask are separate kinds; precedence stays with the caller
    const ambiguous: Request = { kind: "tier", tier: "large", model: "gpt-5.6-terra" };
    void ambiguous;
  });

  it("denies an exact request for a model whose access was lost", async () => {
    const noEntitlements = resolver({
      openai: reportOf("available", { ...RESTRICTED_PLAN }),
    });
    await expect(
      noEntitlements.resolve({ kind: "exact", providerId: "anthropic", model: "gpt-6-sol" }),
    ).resolves.toMatchObject({ modelProvider: claude, model: "gpt-6-sol" });
    await expect(
      noEntitlements.resolve({ kind: "exact", providerId: "openai", model: "gpt-6-astra" }),
    ).rejects.toMatchObject({
      code: "model_unavailable",
      provider: "openai",
      reason: "model_access_denied",
    });
    await expect(
      noEntitlements.resolve({ kind: "exact", providerId: "openai", model: "gpt-6-sol" }),
    ).rejects.toMatchObject({
      code: "model_unavailable",
      provider: "openai",
      reason: "model_access_denied",
    });
    await expect(
      noEntitlements.resolve({ kind: "exact", providerId: "openai", model: "gpt-6-luna" }),
    ).rejects.toMatchObject({
      code: "model_unavailable",
      provider: "openai",
      reason: "model_access_denied",
    });
    await expect(
      noEntitlements.resolve({ kind: "exact", providerId: "openai", model: "gpt-6-sol:high" }),
    ).rejects.toMatchObject({
      code: "model_unavailable",
      provider: "openai",
      reason: "model_access_denied",
    });
    await expect(
      noEntitlements.resolve({
        kind: "exact",
        providerId: "openai",
        model: "gpt-6-sol-2026-04-01:high",
      }),
    ).rejects.toMatchObject({
      code: "model_unavailable",
      provider: "openai",
      reason: "model_access_denied",
    });
    await expect(
      noEntitlements.resolve({ kind: "exact", providerId: "openai", model: "gpt-6-luna:high" }),
    ).rejects.toMatchObject({
      code: "model_unavailable",
      provider: "openai",
      reason: "model_access_denied",
    });
    await expect(
      noEntitlements.resolve({
        kind: "exact",
        providerId: "openai",
        model: "gpt-6-luna-2026-04-01:high",
      }),
    ).rejects.toMatchObject({
      code: "model_unavailable",
      provider: "openai",
      reason: "model_access_denied",
    });
    await expect(
      noEntitlements.resolve({ kind: "exact", providerId: "openai", model: "gpt-5.6-sol" }),
    ).rejects.toMatchObject({
      code: "model_unavailable",
      provider: "openai",
      reason: "model_access_denied",
    });
    await expect(
      noEntitlements.resolve({ kind: "exact", providerId: "openai", model: "gpt-5.6-luna" }),
    ).rejects.toMatchObject({
      code: "model_unavailable",
      provider: "openai",
      reason: "model_access_denied",
    });
    // Terra needs no entitlement and still resolves on the same state.
    await expect(
      noEntitlements.resolve({ kind: "exact", providerId: "openai", model: "gpt-5.6-terra" }),
    ).resolves.toMatchObject({ modelProvider: codex, model: "gpt-5.6-terra" });
  });

  it("reports no available provider when every provider is logged out", async () => {
    const r = resolver({
      openai: reportOf("unauthorized"),
      anthropic: reportOf("unauthorized"),
    });
    await expect(r.resolve({ kind: "tier", tier: "large" })).rejects.toMatchObject({
      message: "No model provider is available",
      code: "no_model_provider_available",
      reason: "no_available_provider",
    });
  });
});
