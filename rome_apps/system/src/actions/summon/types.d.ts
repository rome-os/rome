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
 *
 * // Start in the background and poll for the outcome later
 * const started = await callAction("summon", {
 *   agentName: "coding",
 *   prompt: "Land the migration",
 *   detached: true,
 *   workingDir: "/srv/clones/rome",
 * });
 * // started.data => { mode: "detached", sessionId, turnId, agentName }
 * await callAction("summon_status", { sessionId: started.data.sessionId });
 * await callAction("summon_stop", { sessionId: started.data.sessionId });
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

/** What a `detached: true` summon returns. There is no `result` — the child is
 * still running when this lands. Read the outcome with `summon_status`, and
 * cut it short with `summon_stop`. Both accept this session id from any later
 * turn of the same agent, not just from the session that summoned. */
export interface SummonDetachedOutput {
  readonly mode: "detached";
  /** Durable Rome session id of the child. The handle `summon_status` takes,
   * and the one to pass back as `sessionId` to give this child another prompt. */
  sessionId: string;
  /** The child's first turn. */
  turnId: string;
  agentName: string;
}
