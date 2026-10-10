/**
 * summon — Spawn a subagent in the calling session's project or a given
 * project directory.
 *
 * Agent-callable action. Runs a named agent in `workingDir` when given (a path
 * relative to the projects root, or an absolute path inside it), else in the
 * calling session's project. Supports resuming previous sessions.
 *
 * @example
 * // Start a new coding session
 * const result = await callAction("summon", {
 *   agentName: "coding",
 *   prompt: "Refactor the database layer to use connection pooling",
 * });
 * // result.data => { result: "...", sessionId: "sess_abc" }
 *
 * // Work in a specific project
 * await callAction("summon", {
 *   agentName: "coding",
 *   prompt: "Fix the failing build",
 *   workingDir: "landingpage/content",
 * });
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
