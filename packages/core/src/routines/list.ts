// The routines as the Routines page lists them, each with its latest run. The
// page reads them through `GET /routines`, and agents through
// `system:read_routines` (routines/agent-tools.ts).

import type { RoutineLatestRun, RoutineRunsRepository } from "../db/repositories/routine-runs.js";
import type { RoutinesRepository } from "../db/repositories/routines.js";

type RoutineRow = Awaited<ReturnType<RoutinesRepository["findAll"]>>[number];

/** Every routine with its latest run, or null for one that never ran. */
export async function listRoutinesWithLastRun(deps: {
  routines: Pick<RoutinesRepository, "findAll">;
  routineRuns: Pick<RoutineRunsRepository, "findLatestByRoutineIds">;
}): Promise<Array<{ row: RoutineRow; lastRun: RoutineLatestRun | null }>> {
  const rows = await deps.routines.findAll();
  const latest = await deps.routineRuns.findLatestByRoutineIds(rows.map((r) => r.id));
  return rows.map((row) => ({ row, lastRun: latest.get(row.id) ?? null }));
}
