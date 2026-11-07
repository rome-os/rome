// The agent context's public module: an agent run, from the session that
// gives it continuity down to the ports it calls. Code outside the context
// imports from here and never from domain/, application/ or infrastructure/.

export {
  Session,
  type AgentName,
  type ContinuityKey,
  type CreateSessionOptions,
  type ReplaceSessionOptions,
  type SessionChange,
  type SessionId,
  type SessionState,
  type SessionStatus,
  type TurnCheckpoint,
  type TurnRun,
} from "./domain/session.js";
export type {
  ModelAccount,
  ModelAccountAuthorization,
  ModelAccountStatus,
  ModelAccountUsage,
  ModelAuthorizationMode,
  ModelAuthorizationState,
  ModelBrowserAuthorization,
  ModelDeviceAuthorization,
  ModelPlanType,
  ModelUsageWindow,
} from "./domain/model-account.js";
export { ActiveSessionExistsError, type SessionRepository } from "./domain/session-repository.js";
export type { ModelTier } from "./domain/model-tier.js";
export { matchesModelAlias, stripLegacyReasoningSuffix } from "./domain/model-alias.js";
export {
  CODEX_LUNA_MODEL,
  CODEX_SOL_MODEL,
  CODEX_TERRA_MODEL,
  isModelSelectionId,
  MODEL_SELECTIONS,
  type ModelSelection,
  type ModelSelectionId,
} from "./domain/model-selection.js";
export {
  accountAllowsModel,
  availabilityFromAccount,
  currentAvailability,
  providerAuthorized,
  providerUsable,
  type AccountedProviderId,
  type ModelAvailabilityState,
  type ProviderAvailability,
  type ProviderAvailabilityState,
} from "./domain/provider-availability.js";
export {
  sameProviderTarget,
  soleProviderAtUsageLimit,
  usageSwitchTarget,
  type UsageSwitchTarget,
} from "./domain/usage-switch.js";
export {
  createModelAvailability,
  type CreateModelAvailabilityOptions,
  type ModelAvailability,
  type ModelAvailabilityChange,
} from "./application/model-availability.js";
export type {
  McpServerConfig,
  ModelFunding,
  ModelSessionConfig,
  ModelProvider,
  ModelReasoningEffort,
  ModelSession,
  ModelSessionEvent,
  ModelSessionParams,
  ModelTurnStartedEvent,
  ModelUserInput,
  ProviderId,
  ModelPosition,
  ThreadStart,
} from "./domain/model-port.js";
export type {
  ModelToolCallContext,
  RomeToolDefinition,
  RomeToolGroup,
  RomeToolResult,
  RomeTools,
  ModelToolCallId,
} from "./domain/rome-tools.js";
export { NO_ROME_TOOLS } from "./domain/rome-tools.js";
export { DrizzleSessionRepository } from "./infrastructure/drizzle-session-repository.js";

// The model port's adapters, for the composition root alone. Everything else
// reaches the context through the ports above.
export { AnthropicProvider } from "./infrastructure/model/anthropic/provider.js";
export { ClaudeAccount } from "./infrastructure/model/anthropic/account.js";
export { CodexAppServerProvider } from "./infrastructure/model/codex/app-server-provider.js";
export { CodexAppServerManager } from "./infrastructure/model/codex/app-server-manager.js";
export { SharedCodexAccountService } from "./infrastructure/model/codex/account-service.js";
export { romeCreditsProxyRoutes } from "./infrastructure/model/codex/rome-credits-proxy-route.js";
