/**
 * summon_stop — Ask a detached summon's child session to stop.
 *
 * The child is interrupted, not killed: the call returns once the request is
 * in, and the child ends shortly afterwards. `summon_status` then reports it as
 * `interrupted`, with whatever reply and trace it had produced by then.
 *
 * @example
 * const stop = await callAction("summon_stop", { sessionId: "child-session-1" });
 * // stop.data => { sessionId: "child-session-1", stopped: true, status: "running" }
 *
 * // Nothing was running
 * // stop.data => { sessionId: "child-session-1", stopped: false, status: "completed" }
 *
 * // Not this agent's child
 * // stop.data => { status: "not_found", sessionId: "nope" }
 */

import type { ChildSessionStopResult } from "@rome-os/app-runtime";

/** No child of the calling agent carries this id. Covers an unknown id, a
 * session that is not a child session, and another agent's child alike — a
 * caller cannot tell which. */
export interface SummonStopNotFound {
  readonly status: "not_found";
  readonly sessionId: string;
}

export type SummonStopOutput =
  | (ChildSessionStopResult & { sessionId: string })
  | SummonStopNotFound;
