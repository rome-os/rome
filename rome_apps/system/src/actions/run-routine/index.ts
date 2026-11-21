import { z } from "@rome-os/app-runtime";
import type { Action, ActionConfig, AppActionRuntimeDeps } from "@rome-os/app-runtime";
import { type RoutineControlDeps, routineControlAction } from "../routine-control.js";

export const runRoutineInputSchema = z.object({
  routineId: z.string().describe("The routine's id, from search_routine."),
  input: z
    .record(z.string(), z.unknown())
    .optional()
    .describe(
      "Input for the run, passed to the routine's action as a trigger's would be. Omit for a plain run.",
    ),
});

export function createAction(
  config: ActionConfig,
  deps: AppActionRuntimeDeps<RoutineControlDeps>,
): Action {
  return routineControlAction("runNow", runRoutineInputSchema, config, deps);
}
