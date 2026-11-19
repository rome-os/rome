import { z } from "@rome-os/app-runtime";
import type { Action, ActionConfig, AppActionRuntimeDeps } from "@rome-os/app-runtime";
import { type RoutineControlDeps, routineControlAction } from "../routine-control.js";

export const readRoutineRunInputSchema = z.object({
  routineId: z.string().describe("The routine's id."),
  runId: z.string().describe("The run's id, from list_routine_runs."),
});

export function createAction(
  config: ActionConfig,
  deps: AppActionRuntimeDeps<RoutineControlDeps>,
): Action {
  return routineControlAction("readRun", readRoutineRunInputSchema, config, deps);
}
