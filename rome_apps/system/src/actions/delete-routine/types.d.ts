/**
 * delete_routine — Permanently delete a routine and stop its live schedule.
 *
 * Agent-callable, write. Removes the routine row and tears down its active
 * trigger so it stops firing immediately. Identify the target first with
 * search_routine; when several routines could match the user's description,
 * confirm which one before calling this.
 *
 * Returns `status: "error"` (not a thrown error) for two legitimate outcomes the
 * agent can relay: no routine has the given id, or the routine has in-flight
 * runs (`running` / `pending_approval`) — deletion while a run is active is not
 * yet supported, so the agent should wait for it to finish or cancel it first.
 *
 * @example
 * await callAction("system:delete_routine", { routineId: "abc-123" });
 * // → { deleted: true, routineId: "abc-123", name: "water reminder" }
 */

export interface DeleteRoutineOutput {
  deleted: true;
  routineId: string;
  /** The deleted routine's name, so the agent can confirm what it removed. */
  name: string;
}
