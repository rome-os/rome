// Boot recovery for approved actions a stopped Rome process left unfinished.
// Contract: docs/concepts/messaging.md#approvals.
import type { ActionExecutionsRepository } from "../db/repositories/action-executions.js";
import type { ApprovalsRepository } from "../db/repositories/approvals.js";

const STOPPED_DURING_REPLAY = "Rome stopped while the approved action was running";

/**
 * Fails every approval a stopped process left `queued` or `running`, so the
 * guardian can retry it, and returns how many it failed. A root a `running`
 * one was replaying can read `pending_approval` rather than `running`: the run
 * that requested the approval may have parked it after the replay started,
 * from another action worker. Unless another approval can still resume that
 * root, it ends as an error, as a replay that threw would. Call at boot, after
 * endInterruptedRuns and before any approval executes.
 */
export async function recoverInterruptedApprovals(
  repos: {
    approvals: Pick<ApprovalsRepository, "failInterruptedExecutions" | "hasActiveApprovalForRoot">;
    executions: Pick<ActionExecutionsRepository, "markParkedRootErrored">;
  },
  now: Date,
): Promise<number> {
  const { failed, replayedRoots } = await repos.approvals.failInterruptedExecutions();
  for (const rootExecutionId of replayedRoots) {
    if (repos.approvals.hasActiveApprovalForRoot(rootExecutionId, { countFailed: false })) continue;
    await repos.executions.markParkedRootErrored(rootExecutionId, now, STOPPED_DURING_REPLAY);
  }
  return failed;
}
