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
  type SessionKind,
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
export { catchUpPrompt } from "./domain/catch-up.js";
export {
  HANDOFF_RECENT_TOKENS,
  recentWithin,
  type HandoffContext,
  type RecentMessage,
  type RenewalHandoffs,
} from "./domain/session-handoff.js";
export { restoresSavedSelection, type SessionSettings } from "./domain/session-settings.js";
export {
  evaluateProviderSessionReset,
  type ProviderSessionGenerationFreshness,
  type ProviderSessionResetDecision,
} from "./domain/session-reset.js";
export { projectPath, type AgentFolders } from "./domain/agent-folders.js";
export {
  answersFromQuestionCard,
  askQuestionToolOutput,
  parseAskQuestionInput,
  type Question,
  questionCardFromAnswers,
  questionCardUi,
} from "./domain/ask-question.js";
export type { PromptFacts, PromptMessage, UnseenMessage } from "./domain/prompt-facts.js";
export {
  currentMessageSection,
  replyContextLine,
  replyContextSection,
  withReplyContext,
} from "./domain/reply-context.js";
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
  type EndedAgentTurn,
  type TurnLifecycle,
  type TurnLifecycleListener,
} from "./domain/turn-lifecycle.js";
export type { TurnMiddleware } from "./domain/turn-middleware.js";
export {
  buildRequiredTiming,
  createAgentTurnRef,
  type AgentTurnParentRef,
} from "./domain/turn-ref.js";
export {
  isTerminalEvent,
  isTransientDelta,
  type TransientDeltaType,
} from "./domain/turn-events.js";
export {
  requireAgent,
  resolveSubagents,
  type Agent,
  type AgentCatalog,
  type AgentDefinition,
} from "./domain/agent-definition.js";
export type { Skill, SkillCatalog } from "./domain/skill.js";
export type { AgentAction, AgentActions } from "./domain/agent-action.js";
export type { AgentLog } from "./domain/agent-log.js";
export type { WakeUp } from "./domain/defer.js";
export {
  projectSummary,
  type PromptAgent,
  type PromptMemory,
  type PromptSources,
} from "./domain/system-prompt.js";
export { showsWidgets, widgetDrawingFor, type WidgetDrawing } from "./domain/widget-drawing.js";
export { createSystemPrompts, type SystemPrompts } from "./application/system-prompts.js";
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
  ModelContextCompactedEvent,
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
  subagentRequest,
  subagentToolName,
  type SessionRecordId,
  type Subagent,
  type Subagents,
} from "./domain/subagent.js";
export { NO_ROME_TOOLS, ROME_TOOL_GROUPS } from "./domain/rome-tools.js";
export {
  forkSessionTools,
  ROUTINE_PROPOSAL_TOOL,
  type SessionTools,
} from "./domain/session-tools.js";
export {
  createSessions,
  type AgentSession,
  type ResumeOpening,
  type SessionOpening,
  type AgentSessionKey,
  type Sessions,
  type AgentTurnHandle,
  type AgentTurnInput,
  type SendTurnOptions,
} from "./application/agent-session.js";
export {
  AgentInputQueue,
  type AgentInputReceipt,
  type SubmitOptions,
} from "./application/agent-input-queue.js";
export type { PushLevel, TurnActor, TurnFacts } from "./domain/turn-facts.js";
export { type Audience, narrowerAudience, turnAudience } from "./domain/turn-audience.js";
export type { DeferTool } from "./application/ask-user-tools.js";
export {
  parentTurnSession,
  rootSession,
  storeForkParent,
  storeSubagentParent,
  walkToRoot,
  type StoredRoot,
} from "./domain/session-parent.js";
export type {
  RecordedSession,
  RecordedSessions,
  NewSubagentSession,
} from "./domain/recorded-sessions.js";
export {
  createSubagentCalls,
  type LiveTurns,
  type SessionPlace,
  type SubagentCalls,
  type SubagentSession,
  type SubagentSessions,
  type SubagentTurnLog,
} from "./application/subagent-calls.js";
export { createRomeTools } from "./application/rome-tools.js";
export { romeToolRunner } from "./application/rome-tool-runner.js";
export type { SessionTracing } from "./application/session-tracing.js";
export { translateTurnSpans, type CapturedEvent } from "./application/turn-spans.js";
export { DrizzleSessionRepository } from "./infrastructure/drizzle-session-repository.js";
export { readAnswerShape } from "./infrastructure/answer-shape.js";
export { romeSessionTracing } from "./infrastructure/session-tracing.js";
export { TurnListeners } from "./infrastructure/turn-listeners.js";

// The model port's adapters, for the composition root alone. Everything else
// reaches the context through the ports above.
export { AnthropicProvider } from "./infrastructure/model/anthropic/provider.js";
export { claudeStoppedTurnResult } from "./infrastructure/model/anthropic/stop.js";
export { ClaudeAccount } from "./infrastructure/model/anthropic/account.js";
// How Claude words an exhausted subscription, for a stored error that carries no code.
export { isAnthropicUsageLimitError } from "./infrastructure/model/anthropic/usage-limit.js";
export { CodexAppServerProvider } from "./infrastructure/model/codex/app-server-provider.js";
export { CodexAppServerManager } from "./infrastructure/model/codex/app-server-manager.js";
export { SharedCodexAccountService } from "./infrastructure/model/codex/account-service.js";
export { romeCreditsProxyRoutes } from "./infrastructure/model/codex/rome-credits-proxy-route.js";
export {
  createTierModelsSetting,
  TIER_MODEL_MAPPINGS_SETTING_KEY,
} from "./infrastructure/settings/tier-models-setting.js";

// What the dashboard's login and settings routes and Rome Cloud's Codex
// login use from the model adapters.
export {
  ANTHROPIC_COMPATIBLE_CREDENTIALS_SETTING,
  redactAnthropicCompatibleCredentialsSetting,
  summarizeAnthropicCompatibleCredentials,
  summarizeAnthropicCompatibleCredentialsForEditing,
} from "./infrastructure/model/anthropic/anthropic-compatible-providers.js";
export {
  ClaudeLoginCodeValidationError,
  formatClaudeLoginCodeInput,
} from "./infrastructure/model/anthropic/claude-login-code.js";
export { createClaudeLoginWatcher } from "./infrastructure/model/anthropic/claude-login-watch.js";
export { fetchRomeCredits } from "./infrastructure/model/codex/rome-credits.js";
export {
  ambiguousQuota,
  failoverReason,
  type FailoverReason,
} from "./domain/failover-reason.js";
