// Settles routine runs parked on guardian approval once the approval resolves.
// Contract: docs/concepts/data.md#routines.
import type { RootSettlementHooks } from "../actions/approval-handler.js";
import type { ActionExecutionsRepository } from "../db/repositories/action-executions.js";
import type { ApprovalsRepository } from "../db/repositories/approvals.js";
import type { RoutineRunsRepository } from "../db/repositories/routine-runs.js";

interface ParkedRunRepos {
  executions: Pick<ActionExecutionsRepository, "findTreeRoot">;
  approvals: Pick<ApprovalsRepository, "hasActiveApprovalForRoot">;
  routineRuns: Pick<RoutineRunsRepository, "syncFromRoot">;
}

/**
 * Copies the outcome of the root execution onto the routine run rooted at it,
 * once the root has one and no approval can still resume it, and returns
 * whether a run changed. A failed approval stays retryable, but its replay
 * already gave the root this outcome, and a retry reopens the run. A root
 * still running or parked leaves the run as it is, so the call is safe to
 * repeat.
 */
async function settleRoutineRunFromRoot(
  repos: ParkedRunRepos,
  rootExecutionId: string,
): Promise<boolean> {
  const root = await repos.executions.findTreeRoot(rootExecutionId);
  if (!root) return false;
  if (root.status !== "success" && root.status !== "error" && root.status !== "cancelled") {
    return false;
  }
  if (repos.approvals.hasActiveApprovalForRoot(rootExecutionId, { countFailed: false })) {
    return false;
  }
  return repos.routineRuns.syncFromRoot(rootExecutionId, {
    status: root.status,
    ...(root.status !== "success" && root.error ? { error: root.error } : {}),
  });
}

/** The ApprovalHandler hooks that keep each routine run in step with the root
 * execution it parked on. A replay that starts makes an errored run active
 * again: a retry can still park or finish it. */
export function routineRunApprovalHooks(
  repos: ParkedRunRepos & { routineRuns: Pick<RoutineRunsRepository, "reopenForReplay"> },
): RootSettlementHooks {
  return {
    onRootResuming: async (rootExecutionId) => {
      await repos.routineRuns.reopenForReplay(rootExecutionId);
    },
    onRootResolved: async (rootExecutionId) => {
      await settleRoutineRunFromRoot(repos, rootExecutionId);
    },
  };
}

type SettleParkedRunRepos = {
  executions: Pick<ActionExecutionsRepository, "findTreeRoot" | "markParkedRootRejected">;
  approvals: Pick<ApprovalsRepository, "hasActiveApprovalForRoot" | "hasRejectedApprovalForRoot">;
  routineRuns: Pick<RoutineRunsRepository, "syncFromRoot">;
};

/**
 * Settles the `pending_approval` routine run rooted at `rootExecutionId` if
 * its approvals already resolved, and returns whether it changed. A root
 * still parked behind a rejected approval, with no approval left to resume
 * it, is first recorded as rejected. This covers resolutions that reached the
 * approval but not the run: one made before the run finished parking, before
 * Rome settled parked runs, or one a stop interrupted.
 */
export async function settleParkedRun(
  repos: SettleParkedRunRepos,
  rootExecutionId: string,
  now: Date,
): Promise<boolean> {
  if (
    !repos.approvals.hasActiveApprovalForRoot(rootExecutionId) &&
    repos.approvals.hasRejectedApprovalForRoot(rootExecutionId)
  ) {
    await repos.executions.markParkedRootRejected(rootExecutionId, now);
  }
  return settleRoutineRunFromRoot(repos, rootExecutionId);
}

/**
 * Runs settleParkedRun on every `pending_approval` routine run, and returns
 * how many it settled. Call at boot, after endInterruptedRuns and
 * ApprovalsRepository.failInterruptedExecutions.
 */
export async function settleResolvedParkedRuns(
  repos: SettleParkedRunRepos & {
    routineRuns: Pick<RoutineRunsRepository, "findParkedExecutionIds">;
  },
  now: Date,
): Promise<number> {
  let settled = 0;
  for (const rootExecutionId of await repos.routineRuns.findParkedExecutionIds()) {
    if (await settleParkedRun(repos, rootExecutionId, now)) settled++;
  }
  return settled;
}
