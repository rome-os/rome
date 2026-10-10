import { and, eq, inArray, sql } from "drizzle-orm";
import { v4 as uuid } from "uuid";
import { routineRuns, routines } from "../schema.js";
import type { DrizzleDb } from "../index.js";
import {
  ACTIVE_ROUTINE_RUN_STATUSES,
  type DeleteRoutineResult,
  type Routine,
  type Trigger,
} from "../../routines/types.js";

type RoutineRow = typeof routines.$inferSelect;

export function toRoutine(row: RoutineRow): Routine {
  return {
    id: row.id,
    name: row.name,
    key: row.key ?? undefined,
    managedBy: row.managedBy ?? undefined,
    enabled: row.enabled ?? true,
    trigger: row.trigger as Trigger,
    actionName: row.actionName,
    args: (row.args ?? {}) as Record<string, unknown>,
    createdAt: row.createdAt,
    lastFiredAt: row.lastFiredAt ?? undefined,
    nextRunAt: row.nextRunAt ?? undefined,
  };
}

export class RoutinesRepository {
  constructor(private db: DrizzleDb) {}

  async findAll() {
    const rows = await this.db.select().from(routines);
    return rows;
  }

  async findEnabled() {
    const rows = await this.db.select().from(routines).where(eq(routines.enabled, true));
    return rows;
  }

  async findById(id: string) {
    const rows = await this.db.select().from(routines).where(eq(routines.id, id));
    return rows[0] ?? null;
  }

  /** The trigger type shared by every routine named `name`. Names are not
   * unique, so this is null when the routines disagree or none has the name. */
  async findTriggerTypeByName(name: string): Promise<string | null> {
    const rows = await this.db
      .select({ trigger: routines.trigger })
      .from(routines)
      .where(eq(routines.name, name));
    const types = new Set(rows.map((row) => (row.trigger as Trigger).type));
    return types.size === 1 ? [...types][0] : null;
  }

  /** Look up a routine by its caller-assigned `key`. Used by create_routine to
   * reject a duplicate key before insert (the column's UNIQUE constraint is the
   * authoritative backstop). Returns null when the key is unused. */
  async findByKey(key: string): Promise<Routine | null> {
    const rows = await this.db.select().from(routines).where(eq(routines.key, key));
    return rows[0] ? toRoutine(rows[0]) : null;
  }

  /** Domain-typed read for app actions. `findAll` returns raw rows (trigger as
   * `unknown`, nullable timestamps) for in-process callers that map them with
   * `toRoutine`; this returns `Routine` so the published SDK boundary speaks
   * the domain type instead of leaking drizzle row shapes. */
  async listRoutines(): Promise<Routine[]> {
    const rows = await this.findAll();
    return rows.map(toRoutine);
  }

  /** Delete a routine only if it has no in-flight runs. The active-run count
   * and the delete run in one transaction so a run can't start (or finish)
   * between check and delete — without it, a concurrent fire could be counted
   * as absent and then orphaned by the delete (TOCTOU). Returns which branch
   * was taken so the caller can report it without a second, racy lookup.
   *
   * A routine with `managedBy` set is owned by an app and can only be deleted by
   * that app: pass `actor` = the managing app's id to authorize it. A user-facing
   * delete (dashboard, or the agent's delete_routine) leaves `actor` unset and is
   * refused with `{ status: "managed" }` — the app keeps sole control so a user
   * can't prune a routine the app recreates on its next sync. */
  async deleteIfNoActiveRuns(id: string, actor?: string): Promise<DeleteRoutineResult> {
    return this.db.transaction((tx): DeleteRoutineResult => {
      const routine = tx
        .select({ name: routines.name, managedBy: routines.managedBy })
        .from(routines)
        .where(eq(routines.id, id))
        .get();
      if (!routine) return { status: "not-found" };

      // Refuse unless the caller is the owning app. Checked before the active-run
      // count so a managed routine reports "managed" regardless of run state.
      if (routine.managedBy && routine.managedBy !== actor) {
        return { status: "managed", managedBy: routine.managedBy };
      }

      const active = tx
        .select({ count: sql<number>`count(*)` })
        .from(routineRuns)
        .where(
          and(
            eq(routineRuns.routineId, id),
            inArray(routineRuns.status, [...ACTIVE_ROUTINE_RUN_STATUSES]),
          ),
        )
        .get();
      const activeRuns = Number(active?.count ?? 0);
      if (activeRuns > 0) return { status: "active-runs", activeRuns };

      // routine_runs.routineId is a non-cascading FK to routines.id, so the
      // (terminal) run history must go first or the routine delete violates it.
      // Same transaction → the history can't outlive the routine, nor vice versa.
      tx.delete(routineRuns).where(eq(routineRuns.routineId, id)).run();
      tx.delete(routines).where(eq(routines.id, id)).run();
      return { status: "deleted", name: routine.name };
    });
  }

  async create(data: {
    name: string;
    key?: string;
    managedBy?: string;
    trigger: Trigger;
    actionName: string;
    args: Record<string, unknown>;
    enabled?: boolean;
    nextRunAt?: Date;
  }): Promise<string> {
    const id = uuid();
    const now = new Date();
    await this.db.insert(routines).values({
      id,
      name: data.name,
      key: data.key ?? null,
      managedBy: data.managedBy ?? null,
      enabled: data.enabled ?? true,
      trigger: data.trigger as unknown,
      actionName: data.actionName,
      args: data.args as unknown,
      createdAt: now,
      lastFiredAt: null,
      nextRunAt: data.nextRunAt ?? null,
    });
    return id;
  }

  async update(
    id: string,
    data: Partial<{
      name: string;
      enabled: boolean;
      trigger: Trigger;
      actionName: string;
      args: Record<string, unknown>;
      nextRunAt: Date | null;
    }>,
  ) {
    const values: Record<string, unknown> = {};
    if (data.name !== undefined) values.name = data.name;
    if (data.enabled !== undefined) values.enabled = data.enabled;
    if (data.trigger !== undefined) values.trigger = data.trigger;
    if (data.actionName !== undefined) values.actionName = data.actionName;
    if (data.args !== undefined) values.args = data.args;
    if (data.nextRunAt !== undefined) values.nextRunAt = data.nextRunAt;

    await this.db.update(routines).set(values).where(eq(routines.id, id));
  }

  async updateLastFired(id: string, lastFiredAt: Date) {
    await this.db.update(routines).set({ lastFiredAt }).where(eq(routines.id, id));
  }

  async updateNextRun(id: string, nextRunAt: Date | null) {
    await this.db.update(routines).set({ nextRunAt }).where(eq(routines.id, id));
  }
}
