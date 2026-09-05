/**
 * summon_status — Read a detached summon's child session.
 *
 * The read half of `summon` with `detached: true`: a later turn of the same
 * agent — including a later run of a scheduled routine, which is a fresh
 * session — passes back the `sessionId` that summon returned and gets the
 * child's status, its final reply once it has one, and optionally a tail of its
 * transcript. Safe to poll — it only reads.
 *
 * @example
 * const status = await callAction("summon_status", {
 *   sessionId: "child-session-1",
 *   transcriptTail: 4,
 * });
 * // status.data => { status: "completed", reply: "...", transcript: [...] }
 *
 * // An id no session carries
 * // status.data => { status: "not_found", sessionId: "nope" }
 */

import type { ChildSessionStatusReport } from "@rome-os/app-runtime";

/** No child of the calling agent carries this id. Covers an unknown id, a
 * session that is not a child session, and another agent's child alike — a
 * caller cannot tell which. Distinct from a child that exists but has run no
 * turn, which reports `status: "unknown"`. */
export interface SummonStatusNotFound {
  readonly status: "not_found";
  readonly sessionId: string;
}

export type SummonStatusOutput = ChildSessionStatusReport | SummonStatusNotFound;
