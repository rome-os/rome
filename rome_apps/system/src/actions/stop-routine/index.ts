import { z } from "@rome-os/app-runtime";
import type { Action, ActionConfig, AppActionRuntimeDeps } from "@rome-os/app-runtime";
import { type RoutineControlDeps, routineControlAction } from "../routine-control.js";

export const stopRoutineInputSchema = z.object({
  routineId: z.string().describe("The routine's id, from search_routine."),
});

export function createAction(
  config: ActionConfig,
  deps: AppActionRuntimeDeps<RoutineControlDeps>,
): Action {
  return routineControlAction("stop", stopRoutineInputSchema, config, deps);
}
