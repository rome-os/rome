/**
 * summon — Spawn a subagent in the current project.
 *
 * Agent-callable action (requires guardian approval). Runs a named agent
 * within the current project. Supports resuming previous sessions.
 *
 * @example
 * // Start a new coding session
 * const result = await callAction("summon", {
 *   agentName: "coding",
 *   prompt: "Refactor the database layer to use connection pooling",
 * });
 * // result.data => { result: "...", sessionId: "sess_abc" }
 *
 * // Resume a previous session
 * await callAction("summon", {
 *   agentName: "coding",
 *   prompt: "Continue with the migration tests",
 *   sessionId: "sess_abc",
 * });
 */

import type { RomeSessionRef } from "@rome-os/app-runtime";

export interface SummonSessionStartedEvent {
  readonly type: "rome_session_started";
  readonly agentName: string;
  readonly romeSession: RomeSessionRef;
}

export interface SummonOutput {
  /** The agent's text response/result. */
  result: string;
  /** Session ID for resuming this session later. */
  sessionId: string;
  /** Opaque durable Rome trace for this summon invocation. Pass the complete
   * object to Rome APIs; do not inspect or reconstruct its fields. */
  romeSession: RomeSessionRef;
  /** Provider-native structured payload when the agent config declares an
   * `outputSchema`. Absent otherwise. */
  output?: unknown;
}
