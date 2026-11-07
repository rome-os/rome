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
  ModelAccountStatus,
  ModelAccountUsage,
  ModelAuthorizationMode,
  ModelAuthorizationState,
  ModelBrowserAuthorization,
  ModelDeviceAuthorization,
  ModelPlanType,
  ModelUsageWindow,
} from "./domain/model-account.js";
export type {
  ClaudeLogins,
  CodexLogin,
  CodexLoginChoice,
  CodexLogins,
  ModelLoginKind,
} from "./domain/model-login.js";
export { codexLoginKind } from "./domain/model-login.js";
export { providerAvailability } from "./domain/provider-availability.js";
export { ActiveSessionExistsError, type SessionRepository } from "./domain/session-repository.js";
export { resolveAgentPolicy, type AgentPolicy } from "./domain/agent-policy.js";
export {
  searchSkills,
  toSkillSummary,
  type Skill,
  type SkillCatalog,
} from "./domain/skill.js";
export {
  actionToolOutput,
  describeAction,
  searchActions,
  toActionSummary,
  type AgentAction,
} from "./domain/agent-action.js";
export { MAX_SEARCH_LIMIT, SEARCH_LIMIT_DESCRIPTION } from "./domain/catalog-search.js";
export { askQuestionToolOutput, normalizeAskQuestionForCard } from "./domain/ask-question.js";
export { parseDeferInput, type DeferInput } from "./domain/defer.js";
export type { PromptAgent, PromptSources } from "./domain/system-prompt.js";
export { showsWidgets, widgetDrawingFor, type WidgetDrawing } from "./domain/widget-drawing.js";
export { createSystemPrompts, type SystemPrompts } from "./application/system-prompts.js";
export { createPromptSources } from "./infrastructure/prompt-sources.js";
export {
  buildContinuationBlock,
  buildDeviceFolderBlock,
  buildThreadContextBlock,
  buildWorkspaceContextSection,
  FETCH_CHANNEL_HISTORY_ACTION,
  type WorkspaceContextSnapshot,
} from "./domain/prompt.js";
export {
  buildSlashSkillPrompt,
  parseSlashSkillInvocation,
  type SlashSkillInvocation,
} from "./domain/slash-skill.js";
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
  currentReport,
  providerAuthorized,
  providerUsable,
  type AccountedProviderId,
  type ModelAccountReports,
  type ModelAccountReport,
  type ProviderAvailabilityState,
} from "./domain/model-account-report.js";
export {
  sameProviderTarget,
  soleProviderAtUsageLimit,
  usageSwitchTarget,
  type UsageSwitchTarget,
} from "./domain/usage-switch.js";
export {
  createModelAccounts,
  type AgentLog,
  type CreateModelAccountsOptions,
  type ModelAccounts,
  type ModelAccountChange,
} from "./application/model-accounts.js";
export type {
  McpServerConfig,
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
export { SkillLoader } from "./infrastructure/skill-loader.js";

// The model port's adapters, for the composition root alone. Everything else
// reaches the context through the ports above.
export { AnthropicProvider } from "./infrastructure/model/anthropic/provider.js";
export { ClaudeAccount } from "./infrastructure/model/anthropic/account.js";
export { CodexAppServerProvider } from "./infrastructure/model/codex/app-server-provider.js";
export { CodexAppServerManager } from "./infrastructure/model/codex/app-server-manager.js";
export { SharedCodexAccountService } from "./infrastructure/model/codex/account-service.js";
export { romeCreditsProxyRoutes } from "./infrastructure/model/codex/rome-credits-proxy-route.js";
