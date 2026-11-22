// Reading what a routine's runs did: its run history and one run's action tree.
// The Routines page reads these through `GET /routines/:id/runs[/:runId/trace]`
// and agents through `system:list_routine_runs` and `system:read_routine_run`
// (routines/control.ts), so both see the same records.

import type { RoutineRunsRepository } from "../db/repositories/routine-runs.js";
import type { ActionExecutionsRepository } from "../apps/repositories/action-executions.js";
import type { RoutineRun, RoutineRunStatus } from "./types.js";

/** A routine's runs, newest first. */
export function listRoutineRuns(
  deps: { routineRuns: Pick<RoutineRunsRepository, "findByRoutineId"> },
  routineId: string,
  page: { limit?: number; offset?: number } = {},
): Promise<RoutineRun[]> {
  return deps.routineRuns.findByRoutineId(routineId, page);
}

/** One run with the actions it ran, as a tree. */
export interface RoutineRunDetail {
  runId: string;
  status: RoutineRunStatus;
  error: string | null;
  roots: ActionTraceNode[];
}

/** One run of a routine with its action tree, or null when the routine has no
 * run with that id. */
export async function readRoutineRun(
  deps: {
    routineRuns: Pick<RoutineRunsRepository, "findById">;
    actionExecutions: Pick<ActionExecutionsRepository, "findByRootExecutionIds">;
  },
  routineId: string,
  runId: string,
): Promise<RoutineRunDetail | null> {
  const run = await deps.routineRuns.findById(runId);
  if (!run || run.routineId !== routineId) return null;
  const rows = await deps.actionExecutions.findByRootExecutionIds([run.executionId]);
  return {
    runId: run.id,
    status: run.status,
    error: run.error ?? null,
    roots: buildActionTrace(rows),
  };
}

// Rebuilds the action-execution tree for a run from the flat `action_executions`
// rows that share its root executionId. Two subtleties:
//  - The root is found by `parentId == null`, NOT `id === rootExecutionId`: on
//    the routine path the root action gets a fresh id while rootExecutionId is a
//    pre-seeded group key, so no row's id equals it.
//  - `{mode:"timestamp"}` is second-resolution, so ordering siblings by
//    startedAt can tie; the build order is ascending createdAt with a stable
//    sort — best-effort for same-second siblings.

interface ActionExecutionRowLike {
  id: string;
  actionName: string;
  actionType: string | null;
  status: string;
  args: unknown;
  error: string | null;
  durationMs: number | null;
  initiator: string | null;
  actor?: unknown;
  parentId: string | null;
  startedAt: Date | null;
  finishedAt: Date | null;
  createdAt: Date;
}

/** Mirror of the web `ActionNode` shape (minus the recursive type name). */
export interface ActionTraceNode {
  id: string;
  actionName: string;
  status: string;
  durationMs: number | null;
  error: string | null;
  actionType: string | null;
  initiator: string | null;
  actor: unknown;
  args: unknown;
  startedAt: number | null;
  finishedAt: number | null;
  children: ActionTraceNode[];
}

const toEpochSeconds = (d: Date | null): number | null =>
  d ? Math.floor(d.getTime() / 1000) : null;

export function buildActionTrace(rows: ActionExecutionRowLike[]): ActionTraceNode[] {
  // Ascending createdAt so same-second siblings keep DB insertion order.
  const ordered = [...rows].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  const byId = new Map<string, ActionTraceNode>();
  for (const r of ordered) {
    byId.set(r.id, {
      id: r.id,
      actionName: r.actionName,
      status: r.status,
      durationMs: r.durationMs ?? null,
      error: r.error ?? null,
      actionType: r.actionType ?? null,
      initiator: r.initiator ?? null,
      actor: r.actor ?? null,
      args: r.args ?? null,
      startedAt: toEpochSeconds(r.startedAt),
      finishedAt: toEpochSeconds(r.finishedAt),
      children: [],
    });
  }
  const roots: ActionTraceNode[] = [];
  for (const r of ordered) {
    const node = byId.get(r.id)!;
    const parent = r.parentId ? byId.get(r.parentId) : undefined;
    // Root = no parent. An orphan (parentId set but absent from the set) is
    // reparented to root rather than silently dropped.
    if (parent) parent.children.push(node);
    else roots.push(node);
  }
  const sortChildren = (nodes: ActionTraceNode[]) => {
    nodes.sort((a, b) => (a.startedAt ?? 0) - (b.startedAt ?? 0));
    for (const n of nodes) sortChildren(n.children);
  };
  sortChildren(roots);
  return roots;
}
