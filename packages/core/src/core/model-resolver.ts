import type { ModelProvider, ModelTier, ProviderId } from "./agent-runner.js";
import type { SettingsRepository } from "../db/repositories/settings.js";
import {
  accountAllowsModel,
  CODEX_LUNA_MODEL,
  CODEX_SOL_MODEL,
  CODEX_TERRA_MODEL,
  MODEL_SELECTIONS,
  providerAuthorized,
  providerAvailability,
  providerUsable,
  stripLegacyReasoningSuffix,
  type AccountedProviderId,
  type CodexLogin,
  type CodexLogins,
  type ModelAccounts,
  type ModelAccountReports,
  type ModelSelectionId,
  type ModelAccountReport,
} from "../agent/index.js";
import { createLogger } from "../logger.js";

const log = createLogger("model-resolver");

/** Per-provider overrides for the concrete model a capability tier resolves to. */
export const TIER_MODEL_MAPPINGS_SETTING_KEY = "tierModelMappings";

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
  provider?: AccountedProviderId;
  reason: ModelResolutionErrorReason;
}

/** A recoverable model-selection failure safe to expose over HTTP/SSE. */
export class ModelResolutionError extends Error {
  readonly code: ModelResolutionErrorCode;
  readonly provider?: AccountedProviderId;
  readonly reason: ModelResolutionErrorReason;

  constructor(
    message: string,
    details: {
      code: ModelResolutionErrorCode;
      provider?: AccountedProviderId;
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
 * maps and entitlement upgrades do not apply: the resolver
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
  accounts: Pick<ModelAccounts, "read" | "refresh">;
  providers: ModelProvider[];
  settingsRepo?: Pick<SettingsRepository, "get">;
  codexLogins?: Pick<CodexLogins, "login">;
}

const CLAUDE_TIER_TO_MODEL: Record<ModelTier, string> = {
  large: "claude-opus-5-5[1m]",
  medium: "claude-sonnet-5-5",
  small: "claude-haiku-5-5",
};

const TEST_TIER_TO_MODEL: Record<ModelTier, string> = {
  large: "claude-opus-5-5[1m]",
  medium: "claude-sonnet-5-5",
  small: "claude-haiku-5-5",
};

/**
 * The Codex model for a tier, within what the account's plan allows, or the
 * models the Rome credits gateway serves on that login. An unread account
 * allows any.
 */
function codexModel(
  tier: ModelTier,
  codex: ModelAccountReport | undefined,
  served: ReadonlySet<string> | null,
): string {
  const allows = (model: string): boolean =>
    served ? served.has(model) : !codex || accountAllowsModel(codex.account, model);
  if (tier === "small") return allows(CODEX_LUNA_MODEL) ? CODEX_LUNA_MODEL : CODEX_TERRA_MODEL;
  return allows(CODEX_SOL_MODEL) ? CODEX_SOL_MODEL : CODEX_TERRA_MODEL;
}

/**
 * Settings can also be written outside the dashboard, so treat malformed or
 * blank values as absent rather than letting an invalid setting break model
 * resolution. Values are trimmed here as well as in the dashboard.
 */
function configuredTierModel(
  value: unknown,
  providerId: ProviderId,
  tier: ModelTier,
): string | null {
  if (providerId === "mock" || !value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const providerMappings = (value as Record<string, unknown>)[providerId];
  if (
    !providerMappings ||
    typeof providerMappings !== "object" ||
    Array.isArray(providerMappings)
  ) {
    return null;
  }
  const model = (providerMappings as Record<string, unknown>)[tier];
  return typeof model === "string" && model.trim() ? model.trim() : null;
}

// What people call each provider. The port carries the provider's id only;
// the label is Rome's wording, so it lives with the messages that use it.
const PROVIDER_DISPLAY_NAMES: Record<ProviderId, string> = {
  anthropic: "Claude",
  openai: "Codex (ChatGPT)",
  mock: "Mock",
};

function providerDisplayName(id: ProviderId): string {
  return PROVIDER_DISPLAY_NAMES[id];
}

// Agents, apps, and logs see only the message, not the reason field, so the
// message itself names the cause and when a usage limit ends.
function unavailableCause(provider: ModelProvider, report: ModelAccountReport): string {
  const name = providerDisplayName(provider.id);
  if (!providerAuthorized(report)) return `${name} is not signed in`;
  const until = report.usageLimitUntil;
  return until
    ? `${name} has reached its usage limit until ${until}`
    : `${name} has reached its usage limit`;
}

export function createModelResolver(options: CreateModelResolverOptions): ModelResolver {
  const providers = new Map(options.providers.map((provider) => [provider.id, provider]));

  const refreshAfterFailure = (provider?: AccountedProviderId): void => {
    void options.accounts.refresh(provider).catch((error) => {
      log.warn("model accounts refresh after model resolution failure failed", {
        provider: provider ?? "all",
        error: error instanceof Error ? error.message : String(error),
      });
    });
  };

  /**
   * Throws when the provider is unauthorized, expired or at its usage limit on
   * `login`. Without a login it asks about the guardian's own account.
   */
  const requireUsableProvider = (
    provider: ModelProvider,
    state: ModelAccountReports,
    login?: CodexLogin,
  ): void => {
    const report = state[provider.id];
    const codexLogin = provider.id === "openai" ? login : undefined;
    if (!report || providerAvailability(report, codexLogin) === "available") return;
    const providerId = provider.id as AccountedProviderId;
    refreshAfterFailure(providerId);
    throw new ModelResolutionError(
      `Selected model provider is unavailable: ${unavailableCause(provider, report)}`,
      {
        code: "model_provider_unavailable",
        provider: providerId,
        reason: providerAuthorized(report) ? "quota_exhausted" : "not_logged_in",
      },
    );
  };

  /**
   * Throws when the account's plan does not allow the model. With a known
   * `served` list, the Rome credits gateway decides instead: it accepts only
   * the exact model names it serves.
   */
  const requireModelAccess = (
    providerId: ProviderId,
    model: string,
    codex: ModelAccountReport | undefined,
    served: ReadonlySet<string> | null,
  ): void => {
    if (providerId !== "openai") return;
    const denied = served
      ? !served.has(stripLegacyReasoningSuffix(model))
      : codex !== undefined && !accountAllowsModel(codex.account, model);
    if (!denied) return;
    refreshAfterFailure("openai");
    throw new ModelResolutionError(`Selected model is unavailable: ${model}`, {
      code: "model_unavailable",
      provider: "openai",
      reason: "model_access_denied",
    });
  };

  const usingRomeCredits = (): boolean => options.codexLogins?.login().kind === "rome_credits";
  /**
   * The models the Rome credits gateway reports serving on that login. Null on
   * the guardian's own login, or when the gateway has not reported a list, in
   * which case credits are assumed to serve Sol and Luna.
   */
  const creditsServedModels = (): ReadonlySet<string> | null => {
    const login = options.codexLogins?.login();
    if (login?.kind !== "rome_credits" || !login.modelsServed) return null;
    return new Set(login.modelsServed);
  };
  /**
   * Availability as seen by resolution. On Rome credits, Codex is available
   * and allows the models the gateway serves, or any when the gateway has not
   * said.
   */
  const resolutionState = (state = options.accounts.read()): ModelAccountReports => {
    if (!usingRomeCredits()) return state;
    return {
      ...state,
      openai: { state: "available", account: { loggedIn: true, usageLimited: false } },
    };
  };

  return {
    async getModelProvider(request) {
      if (request.exact) {
        const state = resolutionState();
        const { providerId, model } = request.exact;
        const provider = providers.get(providerId);
        if (!provider) throw new Error(`Unknown model provider: ${providerId}`);
        requireUsableProvider(provider, options.accounts.read(), options.codexLogins?.login());
        requireModelAccess(provider.id, model, state.openai, creditsServedModels());
        return { modelProvider: provider, model };
      }
      if (request.selectionId) {
        const selection = MODEL_SELECTIONS[request.selectionId];
        const state = resolutionState();
        const provider = providers.get(selection.providerId);
        if (!provider) throw new Error(`Unknown model provider: ${selection.providerId}`);
        requireUsableProvider(provider, options.accounts.read(), options.codexLogins?.login());
        requireModelAccess(provider.id, selection.model, state.openai, creditsServedModels());
        return { modelProvider: provider, model: selection.model };
      }

      const tierModelMappings = await options.settingsRepo?.get<unknown>(
        TIER_MODEL_MAPPINGS_SETTING_KEY,
      );
      // Settings reads can yield while account state changes. Read the login
      // and provider state after the await so this resolution sees the current
      // login.
      const accountState = options.accounts.read();
      const onRomeCredits = usingRomeCredits();
      const state = resolutionState(accountState);
      const creditsServed = creditsServedModels();

      const resolveTierModel = (
        provider: ModelProvider,
        providerState = state,
        served = creditsServed,
      ): string => {
        const configured = configuredTierModel(tierModelMappings, provider.id, request.tier);
        const model =
          configured ??
          (provider.id === "openai"
            ? codexModel(request.tier, providerState.openai, served)
            : provider.id === "anthropic"
              ? CLAUDE_TIER_TO_MODEL[request.tier]
              : TEST_TIER_TO_MODEL[request.tier]);
        // A configured model is intentional, but what the login does not allow
        // still fails with the same recoverable error as an exact
        // model selection instead of reaching the provider with a bad request.
        requireModelAccess(provider.id, model, providerState.openai, served);
        return model;
      };

      if (request.providerId) {
        const provider = providers.get(request.providerId);
        if (!provider) throw new Error(`Unknown model provider: ${request.providerId}`);
        // A provider pin by tier asks for that provider's own login. The one
        // Codex pin, image_gen, needs ChatGPT's hosted image tool, which the
        // Rome credits gateway rejects.
        requireUsableProvider(provider, accountState);
        return {
          modelProvider: provider,
          model: resolveTierModel(provider, accountState, null),
        };
      }

      const claude = providers.get("anthropic");
      const codex = providers.get("openai");
      if (codex && providerUsable(accountState.openai)) {
        return { modelProvider: codex, model: resolveTierModel(codex) };
      }
      if (claude && providerUsable(state.anthropic)) {
        return { modelProvider: claude, model: resolveTierModel(claude) };
      }
      // Rome credits run only when no subscription can serve the tier, and only
      // for a tier whose default model the gateway serves. A configured model
      // the gateway does not serve still fails with model_unavailable.
      const creditsServeTier =
        !creditsServed ||
        configuredTierModel(tierModelMappings, "openai", request.tier) !== null ||
        creditsServed.has(codexModel(request.tier, state.openai, creditsServed));
      if (codex && onRomeCredits && creditsServeTier) {
        return { modelProvider: codex, model: resolveTierModel(codex) };
      }

      // Test providers have no login/quota concept. Production only registers
      // Codex and Claude, but accepting a lone mock keeps the provider contract
      // easy to exercise without adding test-only branches to AgentSession.
      const mock = providers.get("mock");
      if (mock) return { modelProvider: mock, model: resolveTierModel(mock) };

      const connectedProviders: ModelAccountReport[] = [];
      if (codex && providerAuthorized(state.openai) && state.openai) {
        connectedProviders.push(state.openai);
      }
      if (claude && providerAuthorized(state.anthropic) && state.anthropic) {
        connectedProviders.push(state.anthropic);
      }
      const allConnectedProvidersQuotaExhausted =
        connectedProviders.length > 0 &&
        connectedProviders.every((provider) => provider.state === "usage_limit_reached");

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
