/**
 * search_routine — Find existing routines by a free-text description.
 *
 * Agent-callable, read-only. The agent uses this to identify which routine(s)
 * a user means before editing or deleting one. Matching is deliberately
 * lenient (any meaningful query token hitting the routine's name, action or
 * args) and ranked by how many tokens matched. The schedule is NOT matched —
 * each result carries its schedule so the agent filters by time itself (e.g.
 * "the morning one") and, when several routines match, asks the user which one
 * to act on.
 *
 * An empty query returns every routine.
 *
 * @example
 * // User: "stop reminding me to drink water in the morning"
 * // Search on content terms only; the time ("morning") is the agent's to
 * // resolve against each result's schedule.
 * await callAction("system:search_routine", { query: "drink water" });
 * // → { totalRoutines: 4, matches: [{ id, name, schedule: "recurring (FREQ=DAILY) at 08:00 ...", ... }] }
 */

export interface RoutineMatch {
  /** Routine id — pass to delete_routine to remove it. */
  id: string;
  name: string;
  /** Caller-assigned stable identity, if the routine has one (e.g. an
   * app-managed routine). Absent on routines created without a key. */
  key?: string;
  enabled: boolean;
  /** The action this routine runs when its trigger fires. */
  actionName: string;
  /** Short human phrase describing when/how the routine fires. */
  schedule: string;
  /** The arguments passed to the action. */
  args: Record<string, unknown>;
}

export interface SearchRoutineOutput {
  /** The query that was searched. */
  query: string;
  /** Total number of routines that exist (match or not). */
  totalRoutines: number;
  /** Matching routines, best match first. Empty when nothing matched. */
  matches: RoutineMatch[];
}
