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
export { ActiveSessionExistsError, type SessionRepository } from "./domain/session-repository.js";
export type { ModelTier } from "./domain/model-tier.js";
export type {
  ActionMcpDefinition,
  ModelProvider,
  ModelReasoningEffort,
  ModelSession,
  ModelSessionFork,
  ModelSessionForkMode,
  ModelSessionForkOpenParams,
  ModelSessionForkParams,
  ModelSessionForkSource,
  ModelSessionParams,
  ModelToolCallContext,
  ModelToolDefinition,
  ModelUserInput,
  ProviderId,
  SkillMcpDefinition,
} from "./domain/model-port.js";
export { DrizzleSessionRepository } from "./infrastructure/drizzle-session-repository.js";

// The model port's adapters, as the composition root wires them. The Codex
// account and credits-proxy members below are what callers outside the
// context reach for today; they narrow as the port is reshaped.
export { AnthropicProvider } from "./infrastructure/model/anthropic/provider.js";
export { CodexAppServerProvider } from "./infrastructure/model/codex/app-server-provider.js";
export { CodexAppServerManager } from "./infrastructure/model/codex/app-server-manager.js";
export {
  SharedCodexAccountService,
  type CodexAccountService,
} from "./infrastructure/model/codex/account-service.js";
export {
  ROME_CREDITS_PROXY_KEY,
  ROME_CREDITS_PROXY_PATH,
} from "./infrastructure/model/codex/rome-credits-provider.js";
export { stripLegacyReasoningSuffix } from "./infrastructure/model/codex/common.js";
