import type { EventBusTrigger, ManualTrigger, ScheduleTrigger } from "@rome-os/app-runtime";

export type {
  DeleteRoutineResult,
  EventBusTrigger,
  EventFilterCondition,
  ManualTrigger,
  ScheduleTrigger,
} from "@rome-os/app-runtime";

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
