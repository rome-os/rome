// Ends the runs a stopped Rome process left `running`. Restart contract:
// docs/concepts/actions.md and docs/concepts/data.md#routines.
import type { ActionExecutionsRepository } from "../db/repositories/action-executions.js";
import type { RoutineRunsRepository } from "../db/repositories/routine-runs.js";
import { hostJobId } from "../host-execution/service.js";
import { HOST_ACTION } from "../host-execution/worker-recovery.js";

export const INTERRUPTED_EXECUTION_ERROR = "Rome stopped before this execution finished";
export const INTERRUPTED_ROUTINE_RUN_ERROR = "Rome stopped before this run finished";

/**
 * Records every `running` action execution and routine run as `error`, and
 * returns how many of each it ended. Call once at boot, before the action
 * engine, routine engine, or any ingress can start work: no live process owns
 * a `running` row then. `pending_approval` rows are kept.
 */
export async function endInterruptedRuns(
  repos: {
    executions: Pick<ActionExecutionsRepository, "markRunningInterrupted">;
    routineRuns: Pick<RoutineRunsRepository, "markRunningInterrupted">;
  },
  now: Date,
): Promise<{ executions: number; routineRuns: number }> {
  const executions = await repos.executions.markRunningInterrupted(now, (row) =>
    // A host job outlives Rome, so the script may have run or still be running.
    row.actionName === HOST_ACTION
      ? `${INTERRUPTED_EXECUTION_ERROR}. Host submission outcome is unknown. Inspect job ${hostJobId(row.id)} with system:manage_root_script before considering another execution.`
      : INTERRUPTED_EXECUTION_ERROR,
  );
  const routineRuns = await repos.routineRuns.markRunningInterrupted(INTERRUPTED_ROUTINE_RUN_ERROR);
  return { executions, routineRuns };
}
