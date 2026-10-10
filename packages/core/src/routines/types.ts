export interface ScheduleTrigger {
  type: "schedule";
  tzid: string; // IANA timezone
  localTime: string; // HH:mm
  /** How `tzid` is bound. Required — every schedule states its
   * binding explicitly; existing rows were backfilled. `floating` ignores the
   * stored `tzid` and resolves `localTime` against the guardian's *current*
   * timezone at (re)activation, so the routine follows the guardian when they
   * change it. `fixed` is the "absolute zone" choice: it pins the schedule to
   * the literal `tzid` forever. DST is handled either way by the cron layer. */
  tzMode: "fixed" | "floating";
  /** Calendar date for a one-off, "YYYY-MM-DD" interpreted in `tzid`.
   * Mutually exclusive with `rrule`. A stored schedule has one or the other:
   * writers resolve "once at the next `localTime`" to a date. */
  date?: string;
  rrule?: string; // iCal RRULE — recurring; mutually exclusive with `date`
}

/** One equality condition on an event's payload. `field` is a dot-path into the
 * payload object (e.g. "from.email"); the condition holds when the value at that
 * path, coerced with String(), equals `equals`. This is the narrowing a user
 * authors in plain language ("from Dana") — not a wildcard over the source. */
export interface EventFilterCondition {
  field: string;
  equals: string;
}

export interface EventBusTrigger {
  type: "event-bus";
  eventName: string; // e.g., "order.created", "provider:event:github.pull_request"
  sourcePattern?: string; // e.g., "deploy_*" to match action names
  /** Payload conditions, AND-ed together. Absent or empty means fire on every
   * event of this name — a legitimate "watch all" routine, so optional. */
  filter?: EventFilterCondition[];
}

/** A routine with no automatic firing condition. Its only entry point is an
 * explicit, out-of-band invocation — the "run now" path (`RoutineEngine.runNow`
 * / `POST /routines/:id/run`). The provider registers the routine so admin
 * surfaces see it as active/ready, but never calls `fire` on its own. Useful
 * for saved playbooks a guardian runs by hand. Carries no config of its own. */
export interface ManualTrigger {
  type: "manual";
}

export type Trigger = ScheduleTrigger | EventBusTrigger | ManualTrigger;

export type TriggerType = Trigger["type"];

export interface Routine {
  id: string;
  name: string;
  /** Optional caller-assigned unique identity, distinct from the human-readable
   * `name`. Used for dedup/idempotency — a caller (e.g. the briefing app) keys
   * its managed routines so it can recreate them without name collisions.
   * Unset on routines that don't opt in. */
  key?: string;
  /** The app that owns and manages this routine (its appId). Set when an app
   * creates a routine it maintains (e.g. briefing). A managed routine can't be
   * deleted by a user — only by the managing app itself. Unset for routines a
   * guardian or agent created directly. */
  managedBy?: string;
  enabled: boolean;

  trigger: Trigger;

  actionName: string;
  args: Record<string, unknown>;

  createdAt: Date;
  lastFiredAt?: Date;
  nextRunAt?: Date; // meaningful for schedule triggers only
}

export type RoutineRunStatus = "success" | "error" | "running" | "pending_approval" | "cancelled";

/** Non-terminal run states. A routine with a run in one of these states is
 * mid-flight (executing, or fired and parked awaiting guardian approval) and
 * must not be deleted out from under it. The remaining states — success,
 * error, cancelled — are terminal. */
export const ACTIVE_ROUTINE_RUN_STATUSES = ["running", "pending_approval"] as const;

/** Outcome of an atomic delete-if-no-active-runs attempt. The active-run check
 * and the delete happen in one transaction, so this is the authoritative
 * result — there is no separate "exists?" race to lose. */
export type DeleteRoutineResult =
  | { status: "deleted"; name: string }
  | { status: "active-runs"; activeRuns: number }
  /** The routine is managed by an app and the caller isn't that app, so the
   * delete was refused. `managedBy` is the owning app's id, for the message. */
  | { status: "managed"; managedBy: string }
  | { status: "not-found" };

export interface RoutineRun {
  id: string;
  routineId: string;
  executionId: string; // links to action_executions.rootExecutionId
  status: RoutineRunStatus;
  payload?: Record<string, unknown>; // the trigger payload that caused the fire
  firedAt: Date;
  durationMs?: number;
  error?: string;
}
