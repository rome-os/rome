// Renaming a routine and turning it off or back on. The Routines page does this
// through `PATCH /routines/:id`, and agents through `system:pause_routine` and
// `system:resume_routine` (routines/agent-tools.ts), so both keep one rule.

import { type RoutinesRepository, toRoutine } from "../db/repositories/routines.js";
import type { RoutineEngine } from "./engine.js";
import { parseDateAndLocalTime } from "./schedule-trigger-provider.js";
import type { Routine } from "./types.js";

export type UpdateRoutineResult =
  | { status: "updated"; routine: Routine }
  | { status: "not-found" }
  | { status: "refused"; error: string };

/** Renames a routine or turns it off or on, and brings its trigger in line. A
 * one-off whose time has passed cannot be turned back on: it would stay on with
 * nothing left to fire. */
export async function updateRoutine(
  deps: {
    routines: Pick<RoutinesRepository, "findById" | "update">;
    engine: Pick<RoutineEngine, "activate" | "deactivate">;
  },
  id: string,
  changes: { name?: string; enabled?: boolean },
): Promise<UpdateRoutineResult> {
  const row = await deps.routines.findById(id);
  if (!row) return { status: "not-found" };

  if (changes.enabled === true) {
    const error = cannotResume(toRoutine(row));
    if (error) return { status: "refused", error };
  }

  await deps.routines.update(id, changes);
  const updated = await deps.routines.findById(id);
  if (!updated) return { status: "not-found" };
  const routine = toRoutine(updated);
  await deps.engine.deactivate(id);
  if (routine.enabled) await deps.engine.activate(routine);
  return { status: "updated", routine };
}

/** Why a routine cannot be turned back on, or null when it can. */
function cannotResume(routine: Routine): string | null {
  const { trigger } = routine;
  if (trigger.type !== "schedule") return null;
  // Writers and migration 0076 date every one-off, so only a malformed row
  // reaches here with neither date nor rrule, and the scheduler refuses it.
  if (!trigger.date && !trigger.rrule?.trim()) {
    return `This one-off at ${trigger.localTime} has no date and can no longer run. Create a new routine to run it.`;
  }
  const state = datedOneOffState(trigger);
  if (state === "past") {
    return `This one-off was set for ${trigger.date} at ${trigger.localTime}, which has passed. Create a new routine to run it again.`;
  }
  if (state === "unparseable") return "schedule.date / localTime is unparseable";
  return null;
}

/** Whether a dated one-off can still fire. A stored tzid Intl rejects makes the
 * parse throw rather than return NaN, so that counts as unparseable too. */
export function datedOneOffState(trigger: {
  date?: string;
  localTime: string;
  tzid: string;
}): "unparseable" | "past" | null {
  if (!trigger.date) return null;
  let fireAt: Date;
  try {
    fireAt = parseDateAndLocalTime(trigger.date, trigger.localTime, trigger.tzid);
  } catch {
    return "unparseable";
  }
  if (Number.isNaN(fireAt.getTime())) return "unparseable";
  return fireAt.getTime() < Date.now() ? "past" : null;
}
