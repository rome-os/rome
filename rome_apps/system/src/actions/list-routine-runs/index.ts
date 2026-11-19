import { z } from "@rome-os/app-runtime";
import type { Action, ActionConfig, AppActionRuntimeDeps } from "@rome-os/app-runtime";
import { type RoutineControlDeps, routineControlAction } from "../routine-control.js";

export const listRoutineRunsInputSchema = z.object({
  routineId: z.string().describe("The routine's id, from search_routine."),
  limit: z
    .number()
    .int()
    .min(1)
    .max(50)
    .optional()
    .describe("How many recent runs to return. Default 10."),
});

export function createAction(
  config: ActionConfig,
  deps: AppActionRuntimeDeps<RoutineControlDeps>,
): Action {
  return routineControlAction("listRuns", listRoutineRunsInputSchema, config, deps);
}
