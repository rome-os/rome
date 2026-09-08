import { and, eq, lt } from "drizzle-orm";
import type { AppDbContext, DrizzleDb } from "@rome-os/app-runtime";
import { createAppDbSchema } from "../schema.js";

export const RECONCILE_LOCK = "reconcile";

/**
 * One reconcile at a time. The lock is a leased row rather than a flag in
 * memory, because an action may run in a worker process and a pass that dies
 * mid-list must not wedge the loop — the lease expires and the next scheduled
 * pass picks the work up.
 */
export class LockRepository {
  private readonly tables;

  constructor(
    private readonly db: DrizzleDb,
    tablePrefix: string,
  ) {
    this.tables = createAppDbSchema(tablePrefix);
  }

  /**
   * Take the lock, or report that someone else holds it. The conditional
   * update is the whole mechanism: SQLite applies it atomically, so exactly one
   * caller sees a changed row.
   */
  tryAcquire(name: string, leaseMs: number, now: Date = new Date()): boolean {
    this.db.insert(this.tables.locks).values({ name, heldUntil: 0 }).onConflictDoNothing().run();

    const result = this.db
      .update(this.tables.locks)
      .set({ heldUntil: now.getTime() + leaseMs })
      .where(and(eq(this.tables.locks.name, name), lt(this.tables.locks.heldUntil, now.getTime())))
      .run();

    return result.changes === 1;
  }

  release(name: string): void {
    this.db
      .update(this.tables.locks)
      .set({ heldUntil: 0 })
      .where(eq(this.tables.locks.name, name))
      .run();
  }
}

export function createLockRepository(ctx: AppDbContext): LockRepository {
  return new LockRepository(ctx.connection, ctx.tablePrefix);
}
