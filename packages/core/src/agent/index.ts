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
export {
  modelResolutionRequest,
  type ModelResolutionRequest,
} from "./domain/model-resolution.js";
export { ActiveSessionExistsError, type SessionRepository } from "./domain/session-repository.js";
export { resolveAgentPolicy, type AgentPolicy } from "./domain/agent-policy.js";
export { turnStatus, turnStop, type TurnEnding } from "./domain/turn-end.js";
export { shapedResult, type AnswerShape, type ReadAnswerShape } from "./domain/answer-shape.js";
export type {
  ReportedAgent,
  SessionServed,
  TurnAttribution,
  TurnUsageFacts,
  TurnUsageReporting,
} from "./domain/turn-usage-reporting.js";
export {
  endedTurn,
  type AgentTurnFailedBeforeStart,
  type TurnLifecycle,
  type TurnLifecycleListener,
} from "./domain/turn-lifecycle.js";
export {
  requireAgent,
  type Agent,
  type AgentCatalog,
  type AgentDefinition,
} from "./domain/agent-definition.js";
export type { Skill, SkillCatalog } from "./domain/skill.js";
export type { AgentAction, AgentActions } from "./domain/agent-action.js";
export type { AgentLog } from "./domain/agent-log.js";
export type { WakeUp } from "./domain/defer.js";
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
  type CreateModelAccountsOptions,
  type ModelAccounts,
  type ModelAccountChange,
} from "./application/model-accounts.js";
export {
  createModelResolver,
  ModelResolutionError,
  toModelResolutionErrorPayload,
  type ModelResolution,
  type ModelResolutionErrorPayload,
  type ModelResolver,
} from "./application/model-resolver.js";
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
  RomeTool,
  RomeToolDefinition,
  RomeToolGroup,
  RomeToolResult,
  RomeTools,
} from "./domain/rome-tools.js";
export {
  refuseResume,
  storedAgentName,
  SubagentOutcomeReader,
  subagentRequest,
  subagentSessionName,
  subagentToolName,
  type SessionRecordId,
  type StoredSubagentSession,
  type Subagent,
  type SubagentOutcome,
  type SubagentRequest,
  type Subagents,
} from "./domain/subagent.js";
export { NO_ROME_TOOLS } from "./domain/rome-tools.js";
export { forkSessionTools } from "./domain/session-tools.js";
export {
  storeForkParent,
  storeSubagentParent,
  walkToRoot,
  type RootSession,
} from "./domain/session-parent.js";
export { createRomeTools } from "./application/rome-tools.js";
export { romeToolRunner } from "./application/rome-tool-runner.js";
export { DrizzleSessionRepository } from "./infrastructure/drizzle-session-repository.js";
export { SkillLoader } from "./infrastructure/skill-loader.js";
export { AgentLoader } from "./infrastructure/agent-loader.js";
export { readAnswerShape } from "./infrastructure/answer-shape.js";
export {
  TurnUsageReporter,
  type TurnUsageReporterDeps,
} from "./infrastructure/turn-usage-reporter.js";
export {
  AppTurnHooks,
  type TurnLifecycleHookLoadFailure,
} from "./infrastructure/app-turn-hooks.js";
export { TurnListeners } from "./infrastructure/turn-listeners.js";

// The model port's adapters, for the composition root alone. Everything else
// reaches the context through the ports above.
export { AnthropicProvider } from "./infrastructure/model/anthropic/provider.js";
export { ClaudeAccount } from "./infrastructure/model/anthropic/account.js";
export { CodexAppServerProvider } from "./infrastructure/model/codex/app-server-provider.js";
export { CodexAppServerManager } from "./infrastructure/model/codex/app-server-manager.js";
export { SharedCodexAccountService } from "./infrastructure/model/codex/account-service.js";
export { romeCreditsProxyRoutes } from "./infrastructure/model/codex/rome-credits-proxy-route.js";
export {
  createTierModelsSetting,
  TIER_MODEL_MAPPINGS_SETTING_KEY,
} from "./infrastructure/settings/tier-models-setting.js";
