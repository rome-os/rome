/**
 * Sessions' public module: everything outside `agent-sessions/` reaches a
 * session through these exports and nothing else. The eval fails an import of
 * any other file in this folder from outside it.
 */

// Opening a session and running its turns.
export {
  createAgentSessionManager,
  NoForkPointError,
  type AgentSession,
  type AgentSessionManager,
  type AgentSessionStatus,
  type AgentTurnHandle,
  type AgentTurnInput,
  type CallerId,
  type ForkedAgentTurnInput,
  type ManagerDeps,
  type SendTurnOptions,
  type SessionOpenOptions,
  type SessionResetRule,
  type SessionSurface,
  type TurnBriefing,
  type TurnInitiator,
} from "./agent-session.js";
export { withTurnExecution, withTurnLinks } from "./turn-context.js";

// The log sessions keep their turns in, over today's rows.
export { createSessionLog, openNamed } from "./rows/session-log.js";
export type { SessionLog } from "./agent-session.js";

// Reading turns and their traces back. Turns are Sessions', so every reader
// outside reads them here.
export {
  createKeptTurnReads,
  createTurnReads,
  type KeptTurns,
  type TraceHead,
  type TurnReads,
  type TurnRef,
} from "./rows/turn-reads.js";
// Chats joins a session's rows into its own transcript queries.
export {
  keptInputOf,
  type KeptTurnMessage,
  keptTurnMessagesOf,
  turnRowsOf,
} from "./rows/turn-rows.js";
// The Sessions explorer's read model of runs.
export {
  type RawSessionRunAggregate,
  type RawSessionStats,
  SessionQueryRepository,
  type SessionQueryStorageScope,
} from "./rows/session-query.js";

// What the wiring builds once and hands to the manager.
export { SessionManager } from "./session-manager.js";
export {
  createAgentLifecycleDispatcher,
  type AgentLifecycleDispatcher,
} from "./agent-lifecycle.js";
export { createTurnMiddlewareChain } from "./turn-middleware.js";
export {
  createActiveSubagentRegistry,
  type ActiveSubagentRegistry,
} from "./active-subagent-registry.js";
export {
  createAgentTurnStreamRegistry,
  type AgentTurnStreamRegistry,
} from "./agent-turn-stream-registry.js";
export { createSubagentExecutionService } from "./subagent-execution.js";
export type { SessionToolContext } from "./session-tools.js";
