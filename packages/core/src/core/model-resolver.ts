import type { ModelProvider, ModelTier, ProviderId } from "./agent-runner.js";
import type { SettingsRepository } from "../db/repositories/settings.js";
import {
  claudeUsesApiKey,
  type AIToolProviderId,
  type AIToolState,
  type AIToolStateValue,
  type ProviderState,
} from "./ai-tool-state.js";
import { WEBCHAT_LARGE_MODEL_SELECTIONS, type ModelSelectionId } from "./model-selector.js";
import { createLogger } from "../logger.js";

const log = createLogger("model-resolver");

export const ENABLE_FABLE_SETTING_KEY = "enableFable";

export type ModelResolutionErrorCode =
  | "model_provider_unavailable"
  | "model_unavailable"
  | "no_model_provider_available";

export type ModelResolutionErrorReason =
  | "not_logged_in"
  | "quota_exhausted"
  | "model_access_denied"
  | "no_available_provider";

export interface ModelResolutionErrorPayload {
  error: string;
  code: ModelResolutionErrorCode;
  provider?: AIToolProviderId;
  reason: ModelResolutionErrorReason;
}

/** A recoverable model-selection failure safe to expose over HTTP/SSE. */
export class ModelResolutionError extends Error {
  readonly code: ModelResolutionErrorCode;
  readonly provider?: AIToolProviderId;
  readonly reason: ModelResolutionErrorReason;

  constructor(
    message: string,
    details: {
      code: ModelResolutionErrorCode;
      provider?: AIToolProviderId;
      reason: ModelResolutionErrorReason;
    },
  ) {
    super(message);
    this.name = "ModelResolutionError";
    this.code = details.code;
    this.provider = details.provider;
    this.reason = details.reason;
  }
}

export function toModelResolutionErrorPayload(error: unknown): ModelResolutionErrorPayload | null {
  if (!(error instanceof ModelResolutionError)) return null;
  return {
    error: error.message,
    code: error.code,
    ...(error.provider ? { provider: error.provider } : {}),
    reason: error.reason,
  };
}

export interface TierModelResolutionRequest {
  tier: ModelTier;
  selectionId?: ModelSelectionId;
  /** Restrict tier resolution to the provider that owns an existing session. */
  providerId?: ProviderId;
  /** Excludes the exact arm: tier and exact requests are mutually exclusive. */
  exact?: never;
}

/**
 * Resolve exactly this provider/model (a session model pin, ADR 0001). Tier
 * maps, entitlement upgrades, and the Fable setting do not apply: the resolver
 * returns exactly the requested model or fails closed with a structured
 * ModelResolutionError — no substitution.
 *
 * The never-typed fields exclude the tier arm so a caller cannot hand the
 * resolver an ambiguous exact-and-tier request; resolution precedence
 * (explicit selection → pin → tier) stays with the caller.
 */
export interface ExactModelResolutionRequest {
  exact: { providerId: ProviderId; model: string };
  tier?: never;
  selectionId?: never;
  providerId?: never;
}

export type ModelResolutionRequest = TierModelResolutionRequest | ExactModelResolutionRequest;

export interface ModelResolution {
  modelProvider: ModelProvider;
  model: string;
}

export interface ModelResolver {
  getModelProvider(request: ModelResolutionRequest): Promise<ModelResolution>;
}

export interface CreateModelResolverOptions {
  aiToolState: Pick<AIToolState, "get" | "refresh">;
  providers: ModelProvider[];
  settingsRepo?: Pick<SettingsRepository, "get">;
}

const CLAUDE_TIER_TO_MODEL: Record<ModelTier, string> = {
  large: "claude-opus-4-8[1m]",
  medium: "claude-sonnet-5",
  small: "claude-haiku-4-5-20251001",
};

const TEST_TIER_TO_MODEL: Record<ModelTier, string> = {
  large: "claude-opus-4-8[1m]",
  medium: "claude-sonnet-5",
  small: "claude-haiku-4-5-20251001",
};

const FABLE_MODEL = "claude-fable-5-1[1m]";

function providerQuotaExhausted(providerId: ProviderId, state: ProviderState): boolean {
  return state.quotaExhausted && !(providerId === "anthropic" && claudeUsesApiKey(state));
}

function providerUsable(providerId: ProviderId, state: ProviderState): boolean {
  return state.loggedIn !== false && !providerQuotaExhausted(providerId, state);
}

function codexModel(tier: ModelTier, state: AIToolStateValue["codex"]): string {
  if (tier === "large") return state.solAccess ? "gpt-5.6-sol" : "gpt-5.6-terra";
  if (tier === "small") return state.lunaAccess ? "gpt-5.6-luna" : "gpt-5.6-terra";
  return "gpt-5.6-terra";
}

function claudeModel(tier: ModelTier, enableFable: boolean): string {
  return tier === "large" && enableFable ? FABLE_MODEL : CLAUDE_TIER_TO_MODEL[tier];
}

function providerState(state: AIToolStateValue, providerId: ProviderId): ProviderState | null {
  if (providerId === "openai") return state.codex;
  if (providerId === "anthropic") return state.claude;
  return null;
}

export function createModelResolver(options: CreateModelResolverOptions): ModelResolver {
  const providers = new Map(options.providers.map((provider) => [provider.id, provider]));

  const refreshAfterFailure = (provider?: AIToolProviderId): void => {
    void options.aiToolState.refresh(provider).catch((error) => {
      log.warn("AI tool state refresh after model resolution failure failed", {
        provider: provider ?? "all",
        error: error instanceof Error ? error.message : String(error),
      });
    });
  };

  /** Throws when the provider is definitely logged out or quota-exhausted. */
  const requireUsableProvider = (provider: ModelProvider, state: AIToolStateValue): void => {
    const availability = providerState(state, provider.id);
    if (!availability || providerUsable(provider.id, availability)) return;
    const providerId = provider.id as AIToolProviderId;
    refreshAfterFailure(providerId);
    throw new ModelResolutionError(
      `Selected model provider is unavailable: ${provider.displayName}`,
      {
        code: "model_provider_unavailable",
        provider: providerId,
        reason: availability.loggedIn === false ? "not_logged_in" : "quota_exhausted",
      },
    );
  };

  /**
   * Throws when the model is entitlement-gated and access is lost. Astra ships
   * to the same paid plans as Sol, so it rides the Sol entitlement.
   */
  const requireModelAccess = (model: string, codex: AIToolStateValue["codex"]): void => {
    const denied =
      (model === "gpt-6-astra" && !codex.solAccess) ||
      (model === "gpt-5.6-sol" && !codex.solAccess) ||
      (model === "gpt-5.6-luna" && !codex.lunaAccess);
    if (!denied) return;
    refreshAfterFailure("openai");
    throw new ModelResolutionError(`Selected model is unavailable: ${model}`, {
      code: "model_unavailable",
      provider: "openai",
      reason: "model_access_denied",
    });
  };

  return {
    async getModelProvider(request) {
      const state = options.aiToolState.get();
      if (request.exact) {
        const { providerId, model } = request.exact;
        const provider = providers.get(providerId);
        if (!provider) throw new Error(`Unknown model provider: ${providerId}`);
        requireUsableProvider(provider, state);
        requireModelAccess(model, state.codex);
        return { modelProvider: provider, model };
      }
      if (request.selectionId) {
        const selection = WEBCHAT_LARGE_MODEL_SELECTIONS[request.selectionId];
        const provider = providers.get(selection.providerId);
        if (!provider) throw new Error(`Unknown model provider: ${selection.providerId}`);
        requireUsableProvider(provider, state);
        requireModelAccess(selection.model, state.codex);
        return { modelProvider: provider, model: selection.model };
      }

      const useFable =
        request.tier === "large" &&
        state.claude.authMethod !== "stored-compatible" &&
        (await options.settingsRepo?.get<unknown>(ENABLE_FABLE_SETTING_KEY)) === true;

      if (request.providerId) {
        const provider = providers.get(request.providerId);
        if (!provider) throw new Error(`Unknown model provider: ${request.providerId}`);
        requireUsableProvider(provider, state);
        if (provider.id === "openai") {
          return { modelProvider: provider, model: codexModel(request.tier, state.codex) };
        }
        if (provider.id === "anthropic") {
          return { modelProvider: provider, model: claudeModel(request.tier, useFable) };
        }
        return { modelProvider: provider, model: TEST_TIER_TO_MODEL[request.tier] };
      }

      const claude = providers.get("anthropic");
      if (useFable && claude && providerUsable("anthropic", state.claude)) {
        return { modelProvider: claude, model: FABLE_MODEL };
      }
      const codex = providers.get("openai");
      if (codex && providerUsable("openai", state.codex)) {
        return { modelProvider: codex, model: codexModel(request.tier, state.codex) };
      }
      if (claude && providerUsable("anthropic", state.claude)) {
        return { modelProvider: claude, model: claudeModel(request.tier, useFable) };
      }

      // Test providers have no login/quota concept. Production only registers
      // Codex and Claude, but accepting a lone mock keeps the provider contract
      // easy to exercise without adding test-only branches to AgentSession.
      const mock = providers.get("mock");
      if (mock) return { modelProvider: mock, model: TEST_TIER_TO_MODEL[request.tier] };

      const connectedProviders: Array<{ id: AIToolProviderId; state: ProviderState }> = [];
      if (codex && state.codex.loggedIn !== false) {
        connectedProviders.push({ id: "openai", state: state.codex });
      }
      if (claude && state.claude.loggedIn !== false) {
        connectedProviders.push({ id: "anthropic", state: state.claude });
      }
      const allConnectedProvidersQuotaExhausted =
        connectedProviders.length > 0 &&
        connectedProviders.every((provider) => providerQuotaExhausted(provider.id, provider.state));

      refreshAfterFailure();
      throw new ModelResolutionError(
        allConnectedProvidersQuotaExhausted
          ? "All connected model providers have reached their usage limits"
          : "No model provider is available",
        {
          code: "no_model_provider_available",
          reason: allConnectedProvidersQuotaExhausted ? "quota_exhausted" : "no_available_provider",
        },
      );
    },
  };
}
