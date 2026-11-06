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
  ModelTier,
  ModelToolCallContext,
  ModelToolDefinition,
  ModelUserInput,
  ProviderId,
  SkillMcpDefinition,
} from "./domain/model-port.js";
export { DrizzleSessionRepository } from "./infrastructure/drizzle-session-repository.js";
