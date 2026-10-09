import { and, asc, desc, eq, gt, inArray, isNull, lte, or, sql } from "drizzle-orm";
import { v4 as uuid } from "uuid";
import { actionExecutions } from "../schema.js";
import type { DrizzleDb } from "../index.js";
import type { SessionActor } from "../../lib/session-actor.js";

export type ActionExecutionStatus =
  | "running"
  | "success"
  | "error"
  | "pending_approval"
  | "cancelled";

export class ActionExecutionsRepository {
  constructor(private db: DrizzleDb) {}

  async create(data: {
    id?: string;
    rootExecutionId?: string;
    actionName: string;
    actionType?: string;
    status: ActionExecutionStatus;
    args?: unknown;
    error?: string;
    durationMs?: number;
    initiator?: string;
    sessionId?: string;
    actor?: SessionActor;
    parentId?: string;
    startedAt?: Date;
    finishedAt?: Date;
    cancelRequestedAt?: Date;
    cancellationReason?: string;
    createdAt?: Date;
  }) {
    const id = data.id ?? uuid();
    const createdAt = data.createdAt ?? data.startedAt ?? new Date();
    const startedAt = data.startedAt ?? createdAt;
    await this.db.insert(actionExecutions).values({
      id,
      rootExecutionId: data.rootExecutionId ?? id,
      actionName: data.actionName,
      actionType: data.actionType ?? null,
      status: data.status,
      args: data.args ?? null,
      error: data.error ?? null,
      durationMs: data.durationMs ?? null,
      initiator: data.initiator ?? null,
      sessionId: data.sessionId ?? null,
      actor: data.actor ?? null,
      parentId: data.parentId ?? null,
      startedAt,
      finishedAt: data.finishedAt ?? null,
      cancelRequestedAt: data.cancelRequestedAt ?? null,
      cancellationReason: data.cancellationReason ?? null,
      createdAt,
    });
    return id;
  }

  async update(
    id: string,
    data: {
      status?: ActionExecutionStatus;
      error?: string | null;
      durationMs?: number | null;
      finishedAt?: Date | null;
      cancelRequestedAt?: Date | null;
      cancellationReason?: string | null;
      actor?: SessionActor;
    },
  ): Promise<void> {
    await this.db
      .update(actionExecutions)
      .set({
        ...(data.status !== undefined ? { status: data.status } : {}),
        ...(data.error !== undefined ? { error: data.error } : {}),
        ...(data.durationMs !== undefined ? { durationMs: data.durationMs } : {}),
        ...(data.finishedAt !== undefined ? { finishedAt: data.finishedAt } : {}),
        ...(data.actor !== undefined ? { actor: data.actor } : {}),
        ...(data.cancelRequestedAt !== undefined
          ? { cancelRequestedAt: data.cancelRequestedAt }
          : {}),
        ...(data.cancellationReason !== undefined
          ? { cancellationReason: data.cancellationReason }
          : {}),
      })
      .where(eq(actionExecutions.id, id));
  }

  async markCancelRequested(
    rootExecutionId: string,
    when = new Date(),
    reason = "Cancelled by user",
  ): Promise<number> {
    const result = await this.db
      .update(actionExecutions)
      .set({
        cancelRequestedAt: when,
        cancellationReason: reason,
      })
      .where(
        and(
          eq(actionExecutions.rootExecutionId, rootExecutionId),
          eq(actionExecutions.status, "running"),
        ),
      );
    return Number(result.changes ?? 0);
  }

  async markRootCancelled(
    rootExecutionId: string,
    finishedAt = new Date(),
    reason = "Cancelled by user",
  ): Promise<number> {
    const result = await this.db
      .update(actionExecutions)
      .set({
        status: "cancelled",
        finishedAt,
        cancelRequestedAt: finishedAt,
        cancellationReason: reason,
      })
      .where(
        and(
          eq(actionExecutions.rootExecutionId, rootExecutionId),
          eq(actionExecutions.status, "running"),
        ),
      );
    return Number(result.changes ?? 0);
  }

  async markRootErrored(
    rootExecutionId: string,
    finishedAt = new Date(),
    error = "Action worker exited unexpectedly",
  ): Promise<number> {
    const result = await this.db
      .update(actionExecutions)
      .set({
        status: "error",
        finishedAt,
        error,
      })
      .where(
        and(
          eq(actionExecutions.rootExecutionId, rootExecutionId),
          eq(actionExecutions.status, "running"),
        ),
      );
    return Number(result.changes ?? 0);
  }

  async findRecent(limit = 50, offset = 0) {
    return this.db
      .select()
      .from(actionExecutions)
      .orderBy(desc(actionExecutions.createdAt))
      .limit(limit)
      .offset(offset);
  }

  async findByAction(actionName: string, limit = 50, offset = 0) {
    return this.db
      .select()
      .from(actionExecutions)
      .where(eq(actionExecutions.actionName, actionName))
      .orderBy(desc(actionExecutions.createdAt))
      .limit(limit)
      .offset(offset);
  }

  async findById(id: string) {
    const rows = await this.db
      .select()
      .from(actionExecutions)
      .where(eq(actionExecutions.id, id))
      .limit(1);
    return rows[0] ?? null;
  }

  async countAll() {
    const result = await this.db.select({ count: sql<number>`count(*)` }).from(actionExecutions);
    return result[0]?.count ?? 0;
  }

  async countByAction(actionName: string) {
    const result = await this.db
      .select({ count: sql<number>`count(*)` })
      .from(actionExecutions)
      .where(eq(actionExecutions.actionName, actionName));
    return result[0]?.count ?? 0;
  }

  /**
   * Top-level executions (no parent) that finished as success, error, or
   * cancelled, in (finishedAt, id) order: strictly after `after` and no later
   * than `until`. Pass the last row's (finishedAt, id) as the next `after` to
   * page. A routine's top-level execution carries the routine run's root id,
   * not its own, so `parentId` is the test for top level.
   */
  async findFinishedTopLevelAfter(params: {
    after: { finishedAt: Date; id: string };
    until: Date;
    limit: number;
  }) {
    const { after } = params;
    return this.db
      .select({
        id: actionExecutions.id,
        actionName: actionExecutions.actionName,
        status: actionExecutions.status,
        initiator: actionExecutions.initiator,
        actor: actionExecutions.actor,
        rootExecutionId: actionExecutions.rootExecutionId,
        durationMs: actionExecutions.durationMs,
        finishedAt: actionExecutions.finishedAt,
      })
      .from(actionExecutions)
      .where(
        and(
          isNull(actionExecutions.parentId),
          inArray(actionExecutions.status, ["success", "error", "cancelled"]),
          lte(actionExecutions.finishedAt, params.until),
          or(
            gt(actionExecutions.finishedAt, after.finishedAt),
            and(
              eq(actionExecutions.finishedAt, after.finishedAt),
              gt(actionExecutions.id, after.id),
            ),
          ),
        ),
      )
      .orderBy(asc(actionExecutions.finishedAt), asc(actionExecutions.id))
      .limit(params.limit);
  }

  async findByRootExecutionIds(rootExecutionIds: string[]) {
    if (rootExecutionIds.length === 0) return [];
    return this.db
      .select()
      .from(actionExecutions)
      .where(inArray(actionExecutions.rootExecutionId, rootExecutionIds))
      .orderBy(desc(actionExecutions.createdAt));
  }
}
