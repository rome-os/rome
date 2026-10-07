import { and, eq, desc, inArray, sql } from "drizzle-orm";
import { v4 as uuid } from "uuid";
import { routineRuns, routines } from "../schema.js";
import type { DrizzleDb } from "../index.js";
import type { RoutineRun, RoutineRunStatus, RoutineStats } from "../../routines/types.js";

type RoutineRunRow = typeof routineRuns.$inferSelect;

/** The most recent run of a routine, as surfaced to the list view's status
 * badge ("Running" / "Failed" / last-run-at). */
export interface RoutineLatestRun {
  status: RoutineRunStatus;
  firedAt: Date;
}

export function toRoutineRun(row: RoutineRunRow): RoutineRun {
  return {
    id: row.id,
    routineId: row.routineId,
    executionId: row.executionId,
    status: row.status as RoutineRunStatus,
    payload: (row.payload ?? undefined) as Record<string, unknown> | undefined,
    firedAt: row.firedAt,
    durationMs: row.durationMs ?? undefined,
    error: row.error ?? undefined,
  };
}

export class RoutineRunsRepository {
  constructor(private db: DrizzleDb) {}

  async create(data: {
    routineId: string;
    executionId: string;
    status: RoutineRunStatus;
    payload?: Record<string, unknown>;
    firedBy?: string;
  }): Promise<string> {
    const id = uuid();
    const now = new Date();
    await this.db.insert(routineRuns).values({
      id,
      routineId: data.routineId,
      executionId: data.executionId,
      status: data.status,
      payload: (data.payload ?? null) as unknown,
      firedBy: data.firedBy ?? null,
      firedAt: now,
      durationMs: null,
      error: null,
    });
    return id;
  }

  async updateStatus(
    id: string,
    data: {
      status: RoutineRunStatus;
      durationMs?: number;
      error?: string;
    },
  ) {
    const values: Record<string, unknown> = { status: data.status };
    if (data.durationMs !== undefined) values.durationMs = data.durationMs;
    if (data.error !== undefined) values.error = data.error;

    await this.db.update(routineRuns).set(values).where(eq(routineRuns.id, id));
  }

  /** A single run by id — the trace endpoint uses this to resolve a run's
   * `executionId` (the root of its action-execution tree). */
  async findById(id: string): Promise<RoutineRun | null> {
    const rows = await this.db.select().from(routineRuns).where(eq(routineRuns.id, id)).limit(1);
    return rows[0] ? toRoutineRun(rows[0]) : null;
  }

  /** What fired the run rooted at `executionId`: a trigger type or `run_now`.
   * A run that predates the column reports its routine's current trigger type.
   * Null when no run has that root. */
  async findFiredBy(executionId: string): Promise<string | null> {
    const rows = await this.db
      .select({ firedBy: routineRuns.firedBy, trigger: routines.trigger })
      .from(routineRuns)
      .leftJoin(routines, eq(routines.id, routineRuns.routineId))
      .where(eq(routineRuns.executionId, executionId))
      .limit(1);
    const row = rows[0];
    if (!row) return null;
    return row.firedBy ?? (row.trigger as { type: string } | null)?.type ?? null;
  }

  async findByRoutineId(
    routineId: string,
    opts: { limit?: number; offset?: number } = {},
  ): Promise<RoutineRun[]> {
    const limit = opts.limit ?? 20;
    const offset = opts.offset ?? 0;

    const rows = await this.db
      .select()
      .from(routineRuns)
      .where(eq(routineRuns.routineId, routineId))
      .orderBy(desc(routineRuns.firedAt))
      .limit(limit)
      .offset(offset);

    return rows.map(toRoutineRun);
  }

  /** Every currently-running run of a routine. The stop path uses this because
   * runs aren't serialized per routine, so more than one can be live at once and
   * an older run can still be running after a newer one finished — looking only
   * at the newest row would miss it. Excludes `pending_approval` deliberately:
   * those have no live process to kill and are the approval flow's to resolve. */
  async findRunningByRoutineId(routineId: string): Promise<RoutineRun[]> {
    const rows = await this.db
      .select()
      .from(routineRuns)
      .where(and(eq(routineRuns.routineId, routineId), eq(routineRuns.status, "running")))
      .orderBy(desc(routineRuns.firedAt));
    return rows.map(toRoutineRun);
  }

  /** Latest run per routine id, batched for the list view's status badges so the
   * cards get Running/Failed/last-run state without an N+1 of per-card queries.
   * Newest-first, keeping the first row seen per routine (id as a deterministic
   * tiebreak when two runs share a fired_at second). Routines with no runs are
   * simply absent from the map. Mirrors `getStats`'s typed Drizzle style; at
   * dashboard scale (a handful of routines) reading their run rows is fine. */
  async findLatestByRoutineIds(ids: string[]): Promise<Map<string, RoutineLatestRun>> {
    const map = new Map<string, RoutineLatestRun>();
    if (ids.length === 0) return map;

    const rows = await this.db
      .select({
        routineId: routineRuns.routineId,
        status: routineRuns.status,
        firedAt: routineRuns.firedAt,
      })
      .from(routineRuns)
      .where(inArray(routineRuns.routineId, ids))
      .orderBy(desc(routineRuns.firedAt), desc(routineRuns.id));

    for (const r of rows) {
      if (!map.has(r.routineId)) {
        map.set(r.routineId, { status: r.status, firedAt: r.firedAt });
      }
    }
    return map;
  }

  async getStats(routineId: string): Promise<RoutineStats> {
    const rows = await this.db
      .select({
        totalRuns: sql<number>`count(*)`,
        successCount: sql<number>`sum(case when ${routineRuns.status} = 'success' then 1 else 0 end)`,
        errorCount: sql<number>`sum(case when ${routineRuns.status} = 'error' then 1 else 0 end)`,
        avgDurationMs: sql<number>`avg(${routineRuns.durationMs})`,
      })
      .from(routineRuns)
      .where(eq(routineRuns.routineId, routineId));

    const agg = rows[0];

    const lastRows = await this.db
      .select()
      .from(routineRuns)
      .where(eq(routineRuns.routineId, routineId))
      .orderBy(desc(routineRuns.firedAt))
      .limit(1);

    const lastRun = lastRows[0];

    return {
      totalRuns: Number(agg?.totalRuns ?? 0),
      successCount: Number(agg?.successCount ?? 0),
      errorCount: Number(agg?.errorCount ?? 0),
      lastStatus: lastRun?.status ?? null,
      lastFiredAt: lastRun?.firedAt ?? null,
      avgDurationMs: agg?.avgDurationMs ? Number(agg.avgDurationMs) : null,
    };
  }

  async deleteByRoutineId(routineId: string) {
    await this.db.delete(routineRuns).where(eq(routineRuns.routineId, routineId));
  }
}
