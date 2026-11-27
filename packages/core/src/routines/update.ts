// Changing a routine: renaming it and turning it off or back on, as the
// Routines page does through `PATCH /routines/:id`, and changing what it runs
// and when. Agents reach it through `system:change_routine`,
// `system:pause_routine` and `system:resume_routine` (routines/agent-tools.ts),
// so every caller keeps one rule.

import {
  chatNamedByArgs,
  type RoutinesRepository,
  toRoutine,
} from "../db/repositories/routines.js";
import {
  checkRoutineAction,
  checkRoutineName,
  checkRoutineTrigger,
  type CreateRoutineDeps,
  type CreateRoutineInput,
} from "./create.js";
import type { RoutineEngine } from "./engine.js";
import { isSyncedRoutineKey } from "./synced-routine-key.js";
import { parseDateAndLocalTime } from "./schedule-trigger-provider.js";
import type { Routine, Trigger } from "./types.js";

export type UpdateRoutineResult =
  | { status: "updated"; routine: Routine }
  | { status: "not-found" }
  | { status: "refused"; error: string };

/** What a change stores, each field already checked. */
export interface RoutineChanges {
  name?: string;
  enabled?: boolean;
  trigger?: Trigger;
  actionName?: string;
  args?: Record<string, unknown>;
}

/** Stores a routine's changes and brings its trigger in line. A one-off whose
 * time has passed cannot be turned back on: it would stay on with nothing left
 * to fire. */
export async function updateRoutine(
  deps: {
    routines: Pick<RoutinesRepository, "findById" | "update">;
    engine: Pick<RoutineEngine, "activate" | "deactivate">;
  },
  id: string,
  changes: RoutineChanges,
): Promise<UpdateRoutineResult> {
  const row = await deps.routines.findById(id);
  if (!row) return { status: "not-found" };

  if (changes.enabled === true) {
    const error = cannotResume({ ...toRoutine(row), ...changes });
    if (error) return { status: "refused", error };
  }

  // A new trigger's next fire is set again when it is activated.
  await deps.routines.update(id, changes.trigger ? { ...changes, nextRunAt: null } : changes);
  const updated = await deps.routines.findById(id);
  if (!updated) return { status: "not-found" };
  const routine = toRoutine(updated);
  await deps.engine.deactivate(id);
  if (routine.enabled) await deps.engine.activate(routine);
  return { status: "updated", routine };
}

/** A change someone asks for: a new name, what the routine runs, or when. */
export interface RoutineChangeRequest {
  name?: string;
  actionName?: string;
  args?: Record<string, unknown>;
  trigger?: CreateRoutineInput["trigger"];
}

/** Changes a routine's name, what it runs or when, each by the rules a new
 * routine meets. A routine an app manages, or one core keeps in line with the
 * Concierge's records, keeps what it runs and when, and a routine keeps the
 * chat it works for. */
export async function changeRoutine(
  deps: Parameters<typeof updateRoutine>[0] &
    Pick<
      CreateRoutineDeps,
      "actionRegistry" | "agentRunner" | "resolveOneOffDate" | "hasTriggerType"
    >,
  id: string,
  request: RoutineChangeRequest,
): Promise<UpdateRoutineResult> {
  const row = await deps.routines.findById(id);
  if (!row) return { status: "not-found" };
  const routine = toRoutine(row);
  const changesWhat = request.actionName !== undefined || request.args !== undefined;
  if ((changesWhat || request.trigger) && routine.managedBy) {
    return {
      status: "refused",
      error: `This routine is managed by the "${routine.managedBy}" app, which decides what it runs and when. Change it from that app.`,
    };
  }
  if ((changesWhat || request.trigger) && isSyncedRoutineKey(routine.key)) {
    return {
      status: "refused",
      error:
        "This routine follows the Concierge's own records, which decide what it runs and when. Change a task's schedule with chat_update, and a follow or the digest with core:concierge_following_configure.",
    };
  }

  const changes: RoutineChanges = {};
  if (request.name !== undefined) {
    const name = checkRoutineName(request.name);
    if (!name.ok) return { status: "refused", error: name.error };
    changes.name = name.value;
  }
  if (changesWhat) {
    const args = request.args ?? routine.args;
    const action = await checkRoutineAction(deps, request.actionName ?? routine.actionName, args);
    if (!action.ok) return { status: "refused", error: action.error };
    // Who may read what its fires say follows the chat it works for.
    const chat = chatNamedByArgs(action.value, args);
    if (chat && chat !== row.chatId) {
      return {
        status: "refused",
        error:
          "A routine keeps the chat it works for. Create a new routine to send into another chat.",
      };
    }
    changes.actionName = action.value;
    changes.args = args;
  }
  if (request.trigger) {
    const trigger = await checkRoutineTrigger(deps, request.trigger);
    if (!trigger.ok) return { status: "refused", error: trigger.error };
    changes.trigger = trigger.value;
  }
  return updateRoutine(deps, id, changes);
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
