import { createHash } from "node:crypto";
import type { InterruptedAction } from "../actions/engine.js";
import type { ActionResult } from "../actions/types.js";
import type { ActionExecutionsRepository } from "../db/repositories/action-executions.js";

const HOST_ACTION = "system:execute_root_script";

/** Lost workers cannot establish host completion. Preserve receipts without submitting replacement jobs. */
export function createHostWorkerRecovery(repo: ActionExecutionsRepository) {
  return async (invocation: InterruptedAction, error: Error): Promise<ActionResult | undefined> => {
    let executions = [{ id: invocation.executionId, rootExecutionId: invocation.rootExecutionId }];
    if (invocation.actionName !== HOST_ACTION) {
      try {
        const rows = await repo.findByRootExecutionIds([invocation.rootExecutionId]);
        const descendants = new Set([invocation.executionId]);
        // Include completed children: their result may never have reached the root caller.
        for (let previousSize = -1; previousSize !== descendants.size; ) {
          previousSize = descendants.size;
          for (const row of rows) {
            if (row.parentId && descendants.has(row.parentId)) descendants.add(row.id);
          }
        }
        executions = rows.filter(
          (row) =>
            descendants.has(row.id) &&
            row.actionName === HOST_ACTION &&
            row.status !== "pending_approval",
        );
      } catch (lookupError) {
        return {
          status: "error",
          error: `${error.message}. Cannot inspect the interrupted execution tree: ${String(lookupError)}. Host jobs may still be running. Inspect execution ${invocation.executionId} (root ${invocation.rootExecutionId}) before retrying.`,
        };
      }
    }
    if (executions.length === 0) return undefined;
    const jobs = executions.map((execution) => ({
      jobId: createHash("sha256").update(execution.id).digest("hex"),
      executionId: execution.id,
      rootExecutionId: execution.rootExecutionId,
      target: "hosting-vm",
      completed: false,
    }));
    return {
      status: "error",
      error: `${error.message}. Host submission outcome is unknown. Inspect each original job with system:manage_root_script before considering another execution.\n${JSON.stringify({ jobs })}`,
    };
  };
}
