import { defineAction } from "@rome-os/app-runtime";
import type {
  Action,
  ActionConfig,
  ActionResult,
  AppActionRuntimeDeps,
} from "@rome-os/app-runtime";
import type { z } from "@rome-os/app-runtime";

// The routine actions beyond create, search and delete are thin: core runs
// each one (routines/control.ts), shared with the Routines page, and these
// actions declare the input agents read and hand it over.

/** Core's routine operations: the main process's own, or a worker's call to
 * it. It reads who asks from the running action. */
export interface RoutineControlService {
  call(op: string, input: unknown): Promise<ActionResult>;
}

export interface RoutineControlDeps {
  routineControl: RoutineControlService;
}

/** The action that hands its input to core's operation `op`. */
export function routineControlAction(
  op: string,
  schema: z.ZodType,
  config: ActionConfig,
  deps: AppActionRuntimeDeps<RoutineControlDeps>,
): Action {
  // The deps bag is untyped at the wiring seam; a missing dep must fail the
  // action load at boot, not on first invocation.
  if (typeof deps.routineControl?.call !== "function") {
    throw new Error(`${config.name} requires a routineControl dep`);
  }
  return defineAction({
    config,
    schema,
    execute: (input) => deps.routineControl.call(op, input),
  });
}
