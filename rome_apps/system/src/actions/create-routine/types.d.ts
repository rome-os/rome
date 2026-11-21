/**
 * create_routine — Create a routine and bring it live, with no confirmation.
 *
 * Agent- and app-callable, write. Persists an enabled routine and activates its
 * trigger immediately, so it starts firing without a confirm card. The trigger
 * is either a `schedule` (recurring `rrule` or one-off `date`, in an IANA
 * `tzid` at `localTime`) or an `event-bus` watch (`eventName`, optional
 * `filter`). `args` is a single object passed to the action — not an array;
 * fan out by creating one routine per argument set.
 *
 * Returns `status: "error"` (not a thrown error) for caller-fixable problems the
 * agent can relay: a malformed schedule, a `date`/`rrule` conflict, an array
 * `args`, or the reserved `__triggerPayload` key.
 *
 * For guardian-initiated "set this up automatically" requests, prefer the
 * routine-from-chat skill (`propose_routine`), which confirms with a card.
 * Reach for `system:create_routine` for direct or programmatic creation.
 *
 * @example
 * // Recurring: every day at 03:00 UTC
 * await callAction("system:create_routine", {
 *   name: "daily-dream",
 *   trigger: { type: "schedule", tzid: "UTC", localTime: "03:00", rrule: "FREQ=DAILY" },
 *   actionName: "dream:dream",
 *   args: {},
 * });
 * // → { routineId: "abc-123" }
 */

export interface CreateRoutineOutput {
  /** The id of the created routine; pass to delete_routine to remove it. */
  routineId: string;
}
