// The model resolver: names the provider and model a run uses, or says why
// none can. It reads the facts once per ask, leaves the decision to
// resolveModel and words a failure as the wire error.
// docs/domains/agents.md carries the language.

import type { ModelAccounts } from "./model-accounts.js";
import type { AgentLog } from "../domain/agent-log.js";
import type { AccountedProviderId } from "../domain/model-account-report.js";
import type { CodexLogins } from "../domain/model-login.js";
import type { ModelProvider, ProviderId } from "../domain/model-port.js";
import {
  resolveModel,
  type ModelResolutionFailure,
  type ModelResolutionRequest,
  type TierModels,
  type TierModelsSetting,
} from "../domain/model-resolution.js";

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

export interface ModelResolution {
  modelProvider: ModelProvider;
  model: string;
}

export interface ModelResolver {
  /** Rejects with ModelResolutionError when none can serve, and a plain Error for an unknown provider. */
  resolve(request: ModelResolutionRequest): Promise<ModelResolution>;
}

export interface CreateModelResolverOptions {
  accounts: Pick<ModelAccounts, "read" | "refresh">;
  providers: ModelProvider[];
  tierModels?: TierModelsSetting;
  codexLogins?: Pick<CodexLogins, "login">;
  log?: AgentLog;
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

export function createModelResolver(options: CreateModelResolverOptions): ModelResolver {
  const providers = new Map(options.providers.map((provider) => [provider.id, provider]));

  const refreshAfterFailure = (provider?: AccountedProviderId): void => {
    void options.accounts.refresh(provider).catch((error) => {
      options.log?.warn("model accounts refresh after model resolution failure failed", {
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

  const decide = (ask: ModelResolutionRequest, tierModels?: TierModels): ModelResolution => {
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
    async resolve(request) {
      if (request.kind === "exact") {
        known(request.providerId);
        return decide(request);
      }
      // Tier models are read first, so the reports and the login this ask
      // reads are the ones current after the read.
      const tierModels = (await options.tierModels?.read()) ?? {};
      if (request.providerId) known(request.providerId);
      return decide(request, tierModels);
    },
  };
}
