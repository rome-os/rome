import { createAppLogger, defineAction, getCurrentActionContext, z } from "@rome-os/app-runtime";
import type {
  Action,
  ActionConfig,
  ActionResult,
  AppActionRuntimeDeps,
  RoutineEngine,
  RoutinesRepository,
} from "@rome-os/app-runtime";
export type { DeleteRoutineOutput } from "./types.js";

const log = createAppLogger("delete-routine");

export const deleteRoutineInputSchema = z.object({
  routineId: z
    .string()
    .describe("The id of the routine to delete (obtain it from system:search_routine)"),
});

export type DeleteRoutineInput = z.infer<typeof deleteRoutineInputSchema>;

export interface DeleteRoutineDeps {
  routinesRepo: RoutinesRepository;
  /** Real engine in the main process, RPC-backed proxy in the action worker —
   * injected per process, so this action never knows where it runs. */
  routineEngine: RoutineEngine;
}

/** Drop the live trigger so a deleted routine stops firing immediately. The
 * row is already gone, so a failed teardown degrades to "deleted but a stale
 * job lingers until next boot" rather than resurrecting the routine. */
async function tearDownTrigger(routineId: string, engine: RoutineEngine): Promise<void> {
  try {
    await engine.deactivate(routineId);
  } catch (err) {
    log.error("failed to cancel routine trigger", {
      routineId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

export async function deleteRoutine(
  input: DeleteRoutineInput,
  deps: DeleteRoutineDeps,
): Promise<ActionResult> {
  // The owning app authorizes its own delete simply by being the caller: the
  // runtime-attributed callerAppId is the actor. A user/agent delete has no
  // callerAppId, so a managed routine is refused (the "managed" branch below).
  const actor = getCurrentActionContext()?.callerAppId;
  const result = await deps.routinesRepo.deleteIfNoActiveRuns(input.routineId, actor);

  switch (result.status) {
    case "not-found":
      return {
        status: "error",
        error:
          `No routine found with id "${input.routineId}". ` +
          "Use system:search_routine to find the right id.",
      };
    case "managed":
      return {
        status: "error",
        error:
          `Routine "${input.routineId}" is managed by the "${result.managedBy}" app and ` +
          "can't be deleted here. Manage it from that app instead.",
      };
    case "active-runs":
      return {
        status: "error",
        error:
          `Routine "${input.routineId}" has ${result.activeRuns} active run(s) ` +
          "(running or awaiting approval) and was not deleted. Wait for them to " +
          "finish, or cancel them, then try again.",
      };
    case "deleted":
      // Only tear down the live trigger once the row is actually gone, so a
      // rejected delete never silently stops a routine we kept.
      await tearDownTrigger(input.routineId, deps.routineEngine);
      return {
        status: "ok",
        data: { deleted: true, routineId: input.routineId, name: result.name },
      };
  }
}

// --- Action factory ---

export function createDeleteRoutineAction(config: ActionConfig, deps: DeleteRoutineDeps): Action {
  return defineAction({
    config,
    schema: deleteRoutineInputSchema,
    execute: (input) => deleteRoutine(input, deps),
  });
}

export function createAction(
  config: ActionConfig,
  deps: AppActionRuntimeDeps<DeleteRoutineDeps>,
): Action {
  // The deps bag is untyped at the wiring seam; a missing engine must fail the
  // action load at boot, not leave deleted routines firing until next restart.
  if (!deps.routineEngine) {
    throw new Error("system:delete_routine requires a routineEngine dep");
  }
  return createDeleteRoutineAction(config, deps);
}
