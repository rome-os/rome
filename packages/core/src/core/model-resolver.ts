import type { ModelProvider, ModelTier, ProviderId } from "./agent-runner.js";
import type { SettingsRepository } from "../db/repositories/settings.js";
import {
  MODEL_SELECTIONS,
  resolveModel,
  type AccountedProviderId,
  type CodexLogins,
  type ModelAccounts,
  type ModelResolutionFailure,
  type ModelResolutionRequest as DomainModelResolutionRequest,
  type ModelSelectionId,
  type TierModels,
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
function resolutionError(failure: ModelResolutionFailure): ModelResolutionError {
  switch (failure.kind) {
    case "provider_unavailable": {
      const name = providerDisplayName(failure.provider);
      const limited = failure.availability === "usage_limit_reached";
      const cause = !limited
        ? `${name} is not signed in`
        : failure.usageLimitUntil
          ? `${name} has reached its usage limit until ${failure.usageLimitUntil}`
          : `${name} has reached its usage limit`;
      return new ModelResolutionError(`Selected model provider is unavailable: ${cause}`, {
        code: "model_provider_unavailable",
        provider: failure.provider,
        reason: limited ? "quota_exhausted" : "not_logged_in",
      });
    }
    case "model_not_allowed":
      return new ModelResolutionError(`Selected model is unavailable: ${failure.model}`, {
        code: "model_unavailable",
        provider: failure.provider,
        reason: "model_access_denied",
      });
    case "none_usable":
      return new ModelResolutionError(
        failure.allAtUsageLimit
          ? "All connected model providers have reached their usage limits"
          : "No model provider is available",
        {
          code: "no_model_provider_available",
          reason: failure.allAtUsageLimit ? "quota_exhausted" : "no_available_provider",
        },
      );
  }
}

/** The provider whose account a failure asks to read again. Undefined reads them all. */
function refreshScope(failure: ModelResolutionFailure): AccountedProviderId | undefined {
  if (failure.kind === "provider_unavailable") return failure.provider;
  if (failure.kind === "model_not_allowed") return "openai";
  return undefined;
}

/** The guardian's tier models, with malformed and blank values dropped. */
function readTierModels(value: unknown): TierModels {
  const tierModels: TierModels = {};
  for (const providerId of ["anthropic", "openai"] as const) {
    for (const tier of ["large", "medium", "small"] as const) {
      const model = configuredTierModel(value, providerId, tier);
      if (model) tierModels[providerId] = { ...tierModels[providerId], [tier]: model };
    }
  }
  return tierModels;
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

  const known = (providerId: ProviderId): ModelProvider => {
    const provider = providers.get(providerId);
    if (!provider) throw new Error(`Unknown model provider: ${providerId}`);
    return provider;
  };

  const resolve = (ask: DomainModelResolutionRequest, tierModels?: TierModels): ModelResolution => {
    const outcome = resolveModel(ask, {
      providers: [...providers.keys()],
      reports: options.accounts.read(),
      logins: { openai: options.codexLogins?.login() },
      tierModels,
    });
    if (!outcome.ok) {
      refreshAfterFailure(refreshScope(outcome.failure));
      throw resolutionError(outcome.failure);
    }
    return { modelProvider: known(outcome.providerId), model: outcome.model };
  };

  return {
    async getModelProvider(request) {
      if (request.exact) {
        const { providerId, model } = request.exact;
        known(providerId);
        return resolve({ kind: "exact", providerId, model });
      }
      if (request.selectionId) {
        const { providerId, model } = MODEL_SELECTIONS[request.selectionId];
        known(providerId);
        return resolve({ kind: "exact", providerId, model });
      }
      // Tier models are read first, so the reports and the login this ask
      // reads are the ones current after the read.
      const tierModels = readTierModels(
        await options.settingsRepo?.get<unknown>(TIER_MODEL_MAPPINGS_SETTING_KEY),
      );
      if (request.providerId) known(request.providerId);
      return resolve(
        { kind: "tier", tier: request.tier, providerId: request.providerId },
        tierModels,
      );
    },
  };
}
