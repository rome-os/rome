import { describe, expect, it, rs } from "@rstest/core";
import type { ModelProvider } from "./agent-runner.js";
import type { AIToolStateValue } from "./ai-tool-state.js";
import {
  createModelResolver,
  ENABLE_FABLE_SETTING_KEY,
  TIER_MODEL_MAPPINGS_SETTING_KEY,
} from "./model-resolver.js";

const codex = { id: "openai", displayName: "Codex" } as ModelProvider;
const claude = { id: "anthropic", displayName: "Claude" } as ModelProvider;

function resolver(
  overrides: Partial<AIToolStateValue> = {},
  settings: { enableFable?: unknown; tierModelMappings?: unknown } = {},
  usingRomeCredits = false,
) {
  const value: AIToolStateValue = {
    codex: { loggedIn: true, quotaExhausted: false, solAccess: true, lunaAccess: true },
    claude: { loggedIn: true, quotaExhausted: false },
    ...overrides,
  };
  return createModelResolver({
    aiToolState: { get: () => value, refresh: async () => value },
    providers: [claude, codex],
    settingsRepo: {
      get: async <T = unknown>(key: string): Promise<T | null> =>
        (key === ENABLE_FABLE_SETTING_KEY
          ? (settings.enableFable ?? null)
          : key === TIER_MODEL_MAPPINGS_SETTING_KEY
            ? (settings.tierModelMappings ?? null)
            : null) as T | null,
    },
    romeCreditsPayer: {
      isUsingRomeCredits: () => usingRomeCredits,
    },
  });
}

describe("ModelResolver", () => {
  it("maps Codex tiers through Sol and Luna", async () => {
    await expect(resolver().getModelProvider({ tier: "large" })).resolves.toMatchObject({
      modelProvider: codex,
      model: "gpt-6.1-sol",
    });
    await expect(resolver().getModelProvider({ tier: "medium" })).resolves.toMatchObject({
      model: "gpt-6.1-sol",
    });
    await expect(resolver().getModelProvider({ tier: "small" })).resolves.toMatchObject({
      model: "gpt-6-luna",
    });
  });

  it("resolves Codex models the same way while Rome credits pay", async () => {
    const loggedOut = {
      codex: { loggedIn: false, quotaExhausted: true, solAccess: false, lunaAccess: false },
      claude: { loggedIn: false, quotaExhausted: false },
    };
    const r = resolver(
      loggedOut,
      { tierModelMappings: { openai: { medium: "gpt-6-astra" } } },
      true,
    );
    await expect(r.getModelProvider({ tier: "large" })).resolves.toMatchObject({
      modelProvider: codex,
      model: "gpt-6.1-sol",
    });
    await expect(r.getModelProvider({ tier: "medium" })).resolves.toMatchObject({
      model: "gpt-6-astra",
    });
    await expect(
      r.getModelProvider({ tier: "small", providerId: "openai" }),
    ).resolves.toMatchObject({ model: "gpt-6-luna" });
    await expect(
      r.getModelProvider({ exact: { providerId: "openai", model: "gpt-6.1-sol" } }),
    ).resolves.toMatchObject({ modelProvider: codex, model: "gpt-6.1-sol" });
  });

  it("fails a tier with no usable provider when credits do not pay", async () => {
    const state: AIToolStateValue = {
      codex: { loggedIn: false, quotaExhausted: false, solAccess: false, lunaAccess: false },
      claude: { loggedIn: false, quotaExhausted: false },
    };
    const r = createModelResolver({
      // Production returns a fresh copy on every read.
      aiToolState: { get: () => structuredClone(state), refresh: async () => state },
      providers: [claude, codex],
      romeCreditsPayer: { isUsingRomeCredits: () => false },
    });
    await expect(r.getModelProvider({ tier: "large" })).rejects.toMatchObject({
      code: "no_model_provider_available",
    });
  });

  it("prefers a connected Claude login over spending Rome credits", async () => {
    const r = resolver(
      {
        codex: { loggedIn: false, quotaExhausted: false, solAccess: false, lunaAccess: false },
        claude: { loggedIn: true, quotaExhausted: false },
      },
      {},
      true,
    );
    await expect(r.getModelProvider({ tier: "large" })).resolves.toMatchObject({
      modelProvider: claude,
    });
  });

  it("uses the payer and provider state that are current after settings reads", async () => {
    let releaseSettings!: () => void;
    const settingsReady = new Promise<void>((resolve) => {
      releaseSettings = resolve;
    });
    let settingsRead!: () => void;
    const settingsStarted = new Promise<void>((resolve) => {
      settingsRead = resolve;
    });
    let usingRomeCredits = false;
    const state: AIToolStateValue = {
      codex: { loggedIn: true, quotaExhausted: false, solAccess: true, lunaAccess: true },
      claude: { loggedIn: false, quotaExhausted: false },
    };
    const r = createModelResolver({
      aiToolState: { get: () => state, refresh: async () => state },
      providers: [claude, codex],
      settingsRepo: {
        get: async () => {
          settingsRead();
          await settingsReady;
          return null;
        },
      },
      romeCreditsPayer: {
        isUsingRomeCredits: () => usingRomeCredits,
      },
    });

    const resolution = r.getModelProvider({ tier: "large" });
    await settingsStarted;
    state.codex.loggedIn = false;
    state.claude.loggedIn = true;
    usingRomeCredits = true;
    releaseSettings();

    await expect(resolution).resolves.toMatchObject({ modelProvider: claude });
  });

  it("falls back from unavailable Sol/Luna to Terra on every tier", async () => {
    const r = resolver({
      codex: {
        loggedIn: true,
        quotaExhausted: false,
        solAccess: false,
        lunaAccess: false,
      },
    });
    await expect(r.getModelProvider({ tier: "large" })).resolves.toMatchObject({
      model: "gpt-5.6-terra",
    });
    await expect(r.getModelProvider({ tier: "medium" })).resolves.toMatchObject({
      model: "gpt-5.6-terra",
    });
    await expect(r.getModelProvider({ tier: "small" })).resolves.toMatchObject({
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

    await expect(r.getModelProvider({ tier: "large" })).resolves.toMatchObject({
      modelProvider: codex,
      model: "custom-codex",
    });
    await expect(
      r.getModelProvider({ tier: "medium", providerId: "openai" }),
    ).resolves.toMatchObject({
      modelProvider: codex,
      model: "custom-codex-medium",
    });
    await expect(
      r.getModelProvider({ tier: "small", providerId: "anthropic" }),
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

    await expect(r.getModelProvider({ tier: "large" })).resolves.toMatchObject({
      model: "gpt-6.1-sol",
    });
    await expect(
      r.getModelProvider({ tier: "medium", providerId: "anthropic" }),
    ).resolves.toMatchObject({
      model: "claude-sonnet-5-5",
    });
  });

  it("prefers Codex, then Claude, and skips definite logout/quota", async () => {
    await expect(resolver().getModelProvider({ tier: "large" })).resolves.toMatchObject({
      modelProvider: codex,
    });
    await expect(
      resolver({
        codex: {
          loggedIn: false,
          quotaExhausted: false,
          solAccess: true,
          lunaAccess: true,
        },
      }).getModelProvider({ tier: "large" }),
    ).resolves.toMatchObject({ modelProvider: claude });
    await expect(
      resolver({
        codex: {
          loggedIn: true,
          quotaExhausted: true,
          solAccess: true,
          lunaAccess: true,
        },
      }).getModelProvider({ tier: "large" }),
    ).resolves.toMatchObject({ modelProvider: claude });
  });

  it("routes large models to Fable when enabled", async () => {
    const settings: { enableFable?: boolean } = {};
    const r = resolver({}, settings);

    await expect(r.getModelProvider({ tier: "large" })).resolves.toMatchObject({
      modelProvider: codex,
      model: "gpt-6.1-sol",
    });

    settings.enableFable = true;

    await expect(r.getModelProvider({ tier: "large" })).resolves.toMatchObject({
      modelProvider: claude,
      model: "claude-fable-5-1[1m]",
    });
    await expect(
      r.getModelProvider({ tier: "large", providerId: "anthropic" }),
    ).resolves.toMatchObject({
      modelProvider: claude,
      model: "claude-fable-5-1[1m]",
    });
    await expect(r.getModelProvider({ tier: "medium" })).resolves.toMatchObject({
      modelProvider: codex,
      model: "gpt-6.1-sol",
    });
  });

  it("uses an Anthropic large mapping instead of Fable's model ID", async () => {
    await expect(
      resolver(
        {},
        {
          enableFable: true,
          tierModelMappings: { anthropic: { large: "custom-claude-large" } },
        },
      ).getModelProvider({ tier: "large" }),
    ).resolves.toMatchObject({
      // Fable still selects Claude as the preferred provider for a large tier.
      modelProvider: claude,
      model: "custom-claude-large",
    });
  });

  it("falls back to Codex when Fable is enabled but Claude is unavailable", async () => {
    await expect(
      resolver(
        { claude: { loggedIn: false, quotaExhausted: false } },
        { enableFable: true },
      ).getModelProvider({ tier: "large" }),
    ).resolves.toMatchObject({
      modelProvider: codex,
      model: "gpt-6.1-sol",
    });
  });

  it("does not route large models to Fable through an Anthropic-compatible provider", async () => {
    const r = resolver(
      {
        claude: {
          loggedIn: true,
          quotaExhausted: false,
          authMethod: "stored-compatible",
        },
      },
      { enableFable: true },
    );

    await expect(r.getModelProvider({ tier: "large" })).resolves.toMatchObject({
      modelProvider: codex,
      model: "gpt-6.1-sol",
    });
    await expect(
      r.getModelProvider({ tier: "large", providerId: "anthropic" }),
    ).resolves.toMatchObject({
      modelProvider: claude,
      model: "claude-opus-5-5[1m]",
    });
  });

  it("resolves a tier on the requested provider", async () => {
    await expect(
      resolver().getModelProvider({ tier: "large", providerId: "anthropic" }),
    ).resolves.toMatchObject({
      modelProvider: claude,
      model: "claude-opus-5-5[1m]",
    });
    await expect(
      resolver().getModelProvider({ tier: "small", providerId: "anthropic" }),
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
      resolver().getModelProvider({ tier: "small", providerId: "openai" }),
    ).resolves.toMatchObject({
      modelProvider: codex,
      model: "gpt-6-luna",
    });
    await expect(
      resolver({
        codex: { loggedIn: false, quotaExhausted: false, solAccess: false, lunaAccess: false },
      }).getModelProvider({ tier: "small", providerId: "openai" }),
    ).rejects.toMatchObject({
      code: "model_provider_unavailable",
      provider: "openai",
      reason: "not_logged_in",
    });
  });

  it("resolves GPT-6.1 Sol selections and exact aliases with Sol access", async () => {
    await expect(
      resolver().getModelProvider({ tier: "large", providerId: "openai" }),
    ).resolves.toMatchObject({ modelProvider: codex, model: "gpt-6.1-sol" });
    await expect(
      resolver().getModelProvider({ tier: "large", selectionId: "gpt-6-1-sol" }),
    ).resolves.toMatchObject({ modelProvider: codex, model: "gpt-6.1-sol" });
    await expect(
      resolver().getModelProvider({ tier: "large", selectionId: "gpt-6-sol" }),
    ).resolves.toMatchObject({ modelProvider: codex, model: "gpt-6-sol" });

    const unavailable = resolver({
      codex: { loggedIn: true, quotaExhausted: false, solAccess: false, lunaAccess: false },
    });
    await expect(
      unavailable.getModelProvider({ tier: "large", selectionId: "gpt-6-1-sol" }),
    ).rejects.toMatchObject({ code: "model_unavailable", reason: "model_access_denied" });

    for (const model of ["gpt-6.1-sol", "gpt-6.1-sol:high", "gpt-6.1-sol-2026-10-01:high"]) {
      await expect(
        resolver().getModelProvider({ exact: { providerId: "openai", model } }),
      ).resolves.toMatchObject({ modelProvider: codex, model });
      await expect(
        unavailable.getModelProvider({ exact: { providerId: "openai", model } }),
      ).rejects.toMatchObject({
        code: "model_unavailable",
        provider: "openai",
        reason: "model_access_denied",
      });
    }
  });

  it("keeps explicit Astra/Sol/Luna exact and never falls back", async () => {
    await expect(
      resolver().getModelProvider({ tier: "large", selectionId: "gpt-6-astra" }),
    ).resolves.toMatchObject({ modelProvider: codex, model: "gpt-6-astra" });
    await expect(
      resolver().getModelProvider({ tier: "large", selectionId: "gpt-5-6-sol" }),
    ).resolves.toMatchObject({ modelProvider: codex, model: "gpt-5.6-sol" });
    await expect(
      resolver().getModelProvider({ tier: "large", selectionId: "gpt-5-6-luna" }),
    ).resolves.toMatchObject({ modelProvider: codex, model: "gpt-5.6-luna" });

    const unavailable = resolver({
      codex: {
        loggedIn: true,
        quotaExhausted: false,
        solAccess: false,
        lunaAccess: false,
      },
    });
    await expect(
      unavailable.getModelProvider({ tier: "large", selectionId: "gpt-5-6-sol" }),
    ).rejects.toThrow("Selected model is unavailable");
    await expect(
      unavailable.getModelProvider({ tier: "large", selectionId: "gpt-6-astra" }),
    ).rejects.toThrow("Selected model is unavailable");
  });

  it("classifies an unavailable explicit provider and refreshes it asynchronously", async () => {
    const value: AIToolStateValue = {
      codex: {
        loggedIn: false,
        quotaExhausted: false,
        solAccess: true,
        lunaAccess: true,
      },
      claude: { loggedIn: true, quotaExhausted: false },
    };
    let finishRefresh!: () => void;
    const refresh = rs.fn(
      () =>
        new Promise<AIToolStateValue>((resolve) => {
          finishRefresh = () => resolve(value);
        }),
    );
    const r = createModelResolver({
      providers: [claude, codex],
      aiToolState: { get: () => value, refresh },
    });

    await expect(
      r.getModelProvider({ tier: "large", selectionId: "gpt-5-6-sol" }),
    ).rejects.toMatchObject({
      code: "model_provider_unavailable",
      provider: "openai",
      reason: "not_logged_in",
    });
    expect(refresh).toHaveBeenCalledWith("openai");
    finishRefresh();
  });

  it("distinguishes quota exhaustion from a missing login", async () => {
    const value: AIToolStateValue = {
      codex: { loggedIn: true, quotaExhausted: true, solAccess: true, lunaAccess: true },
      claude: { loggedIn: true, quotaExhausted: false },
    };
    const r = createModelResolver({
      providers: [claude, codex],
      aiToolState: { get: () => value, refresh: async () => value },
    });

    await expect(
      r.getModelProvider({ tier: "large", selectionId: "gpt-5-6-sol" }),
    ).rejects.toMatchObject({
      code: "model_provider_unavailable",
      provider: "openai",
      reason: "quota_exhausted",
    });
  });

  it("reports quota exhaustion when every connected provider is exhausted", async () => {
    const r = resolver({
      codex: {
        loggedIn: true,
        quotaExhausted: true,
        solAccess: true,
        lunaAccess: true,
      },
      claude: { loggedIn: true, quotaExhausted: true },
    });
    await expect(r.getModelProvider({ tier: "large" })).rejects.toMatchObject({
      message: "All connected model providers have reached their usage limits",
      code: "no_model_provider_available",
      reason: "quota_exhausted",
    });
  });

  it("keeps Claude API-key-backed providers available despite stale quota state", async () => {
    await expect(
      resolver({
        codex: {
          loggedIn: false,
          quotaExhausted: false,
          solAccess: false,
          lunaAccess: false,
        },
        claude: {
          loggedIn: true,
          authMethod: "stored-compatible",
          quotaExhausted: true,
        },
      }).getModelProvider({ tier: "large" }),
    ).resolves.toMatchObject({ modelProvider: claude });
  });

  it("returns exactly the requested provider/model for an exact request", async () => {
    // Tier resolution would prefer Codex (Sol); the exact request must win untouched.
    await expect(
      resolver().getModelProvider({
        exact: { providerId: "anthropic", model: "claude-sonnet-5" },
      }),
    ).resolves.toMatchObject({ modelProvider: claude, model: "claude-sonnet-5" });
    // Sol entitlement would upgrade a large tier to Sol; an exact Terra pin stays Terra.
    await expect(
      resolver().getModelProvider({
        exact: { providerId: "openai", model: "gpt-5.6-terra" },
      }),
    ).resolves.toMatchObject({ modelProvider: codex, model: "gpt-5.6-terra" });
  });

  it("keeps a Fable pin running regardless of the Fable setting", async () => {
    // enableFable is off: tier resolution would never produce Fable, the pin still runs it.
    await expect(
      resolver().getModelProvider({
        exact: { providerId: "anthropic", model: "claude-fable-5-1[1m]" },
      }),
    ).resolves.toMatchObject({ modelProvider: claude, model: "claude-fable-5-1[1m]" });
    // enableFable is on: an exact non-Fable pin is not rerouted to Fable.
    await expect(
      resolver({}, { enableFable: true }).getModelProvider({
        exact: { providerId: "anthropic", model: "claude-opus-4-8[1m]" },
      }),
    ).resolves.toMatchObject({ modelProvider: claude, model: "claude-opus-4-8[1m]" });
  });

  it("fails an exact request closed when its provider is logged out, and refreshes it", async () => {
    const value: AIToolStateValue = {
      codex: { loggedIn: false, quotaExhausted: false, solAccess: true, lunaAccess: true },
      // The other provider is fully usable — an exact request must not substitute it.
      claude: { loggedIn: true, quotaExhausted: false },
    };
    const refresh = rs.fn(async () => value);
    const r = createModelResolver({
      providers: [claude, codex],
      aiToolState: { get: () => value, refresh },
    });

    await expect(
      r.getModelProvider({ exact: { providerId: "openai", model: "gpt-5.6-terra" } }),
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
        claude: { loggedIn: true, quotaExhausted: true },
      }).getModelProvider({ exact: { providerId: "anthropic", model: "claude-sonnet-5" } }),
    ).rejects.toMatchObject({
      code: "model_provider_unavailable",
      provider: "anthropic",
      reason: "quota_exhausted",
    });
  });

  it("rejects ambiguous exact-and-tier requests at the type level", () => {
    type Request = Parameters<ReturnType<typeof resolver>["getModelProvider"]>[0];
    const exact = { providerId: "openai", model: "gpt-5.6-terra" } as const;
    // @ts-expect-error — the exact and tier arms are mutually exclusive; precedence stays with the caller
    const ambiguous: Request = { tier: "large", exact };
    void ambiguous;
  });

  it("denies an exact request for a model whose access was lost", async () => {
    const noEntitlements = resolver({
      codex: { loggedIn: true, quotaExhausted: false, solAccess: false, lunaAccess: false },
    });
    await expect(
      noEntitlements.getModelProvider({ exact: { providerId: "anthropic", model: "gpt-6-sol" } }),
    ).resolves.toMatchObject({ modelProvider: claude, model: "gpt-6-sol" });
    await expect(
      noEntitlements.getModelProvider({ exact: { providerId: "openai", model: "gpt-6-astra" } }),
    ).rejects.toMatchObject({
      code: "model_unavailable",
      provider: "openai",
      reason: "model_access_denied",
    });
    await expect(
      noEntitlements.getModelProvider({ exact: { providerId: "openai", model: "gpt-6-sol" } }),
    ).rejects.toMatchObject({
      code: "model_unavailable",
      provider: "openai",
      reason: "model_access_denied",
    });
    await expect(
      noEntitlements.getModelProvider({ exact: { providerId: "openai", model: "gpt-6-luna" } }),
    ).rejects.toMatchObject({
      code: "model_unavailable",
      provider: "openai",
      reason: "model_access_denied",
    });
    await expect(
      noEntitlements.getModelProvider({ exact: { providerId: "openai", model: "gpt-6-sol:high" } }),
    ).rejects.toMatchObject({
      code: "model_unavailable",
      provider: "openai",
      reason: "model_access_denied",
    });
    await expect(
      noEntitlements.getModelProvider({
        exact: { providerId: "openai", model: "gpt-6-sol-2026-04-01:high" },
      }),
    ).rejects.toMatchObject({
      code: "model_unavailable",
      provider: "openai",
      reason: "model_access_denied",
    });
    await expect(
      noEntitlements.getModelProvider({
        exact: { providerId: "openai", model: "gpt-6-luna:high" },
      }),
    ).rejects.toMatchObject({
      code: "model_unavailable",
      provider: "openai",
      reason: "model_access_denied",
    });
    await expect(
      noEntitlements.getModelProvider({
        exact: { providerId: "openai", model: "gpt-6-luna-2026-04-01:high" },
      }),
    ).rejects.toMatchObject({
      code: "model_unavailable",
      provider: "openai",
      reason: "model_access_denied",
    });
    await expect(
      noEntitlements.getModelProvider({ exact: { providerId: "openai", model: "gpt-5.6-sol" } }),
    ).rejects.toMatchObject({
      code: "model_unavailable",
      provider: "openai",
      reason: "model_access_denied",
    });
    await expect(
      noEntitlements.getModelProvider({ exact: { providerId: "openai", model: "gpt-5.6-luna" } }),
    ).rejects.toMatchObject({
      code: "model_unavailable",
      provider: "openai",
      reason: "model_access_denied",
    });
    // Terra needs no entitlement and still resolves on the same state.
    await expect(
      noEntitlements.getModelProvider({ exact: { providerId: "openai", model: "gpt-5.6-terra" } }),
    ).resolves.toMatchObject({ modelProvider: codex, model: "gpt-5.6-terra" });
  });

  it("reports no available provider when every provider is logged out", async () => {
    const r = resolver({
      codex: {
        loggedIn: false,
        quotaExhausted: false,
        solAccess: true,
        lunaAccess: true,
      },
      claude: { loggedIn: false, quotaExhausted: false },
    });
    await expect(r.getModelProvider({ tier: "large" })).rejects.toMatchObject({
      message: "No model provider is available",
      code: "no_model_provider_available",
      reason: "no_available_provider",
    });
  });
});
