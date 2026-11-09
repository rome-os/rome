import { and, eq, or, desc, gte, inArray, sql } from "drizzle-orm";
import { v4 as uuid } from "uuid";
import { approvals } from "../../db/schema.js";
import type { DrizzleDb } from "../../db/index.js";
import { APPROVAL_TYPES, type ApprovalStatus, type ApprovalType } from "@rome/api-types/approvals";

type ApprovalRow = typeof approvals.$inferSelect;
type ResolveAction = "approve" | "reject";

export type ResolvePendingResult =
  | { outcome: "resolved"; approval: ApprovalRow }
  | { outcome: "not_found" }
  | { outcome: "already_resolved"; approval: ApprovalRow };

/**
 * How long an approval holds the session it would resume: a pending one from
 * when it was asked for, an executing one from when it was approved. Past
 * it, a reset may replace the session, and the approval, once answered,
 * resumes the chat's current session with the continuation notice.
 */
export const APPROVAL_HOLDS_SESSION_MS = 24 * 60 * 60 * 1000;

export type RetryExecutionResult =
  | { outcome: "queued"; approval: ApprovalRow }
  | { outcome: "not_found" }
  | { outcome: "not_retryable"; approval: ApprovalRow };

function activeActionExecutionApproval() {
  return and(
    eq(approvals.type, "action_execution"),
    or(
      eq(approvals.status, "pending"),
      and(
        eq(approvals.status, "approved"),
        or(
          eq(approvals.executionState, "idle"),
          eq(approvals.executionState, "queued"),
          eq(approvals.executionState, "running"),
          eq(approvals.executionState, "failed"),
        ),
      ),
    ),
  );
}

/** An approval as {@link ApprovalsRepository.create} stored it. */
export interface CreatedApproval {
  id: string;
  type: ApprovalType;
  status: ApprovalStatus;
  description: string;
  payload: unknown;
}

export type ApprovalCreatedListener = (approval: CreatedApproval) => void;

export class ApprovalsRepository {
  private createdListeners = new Set<ApprovalCreatedListener>();

  constructor(private db: DrizzleDb) {}

  async list(status?: ApprovalStatus) {
    return this.db
      .select()
      .from(approvals)
      .where(status ? eq(approvals.status, status) : undefined)
      .orderBy(desc(approvals.createdAt), desc(approvals.id))
      .all();
  }

  async create(data: {
    type: ApprovalType;
    requestedBy: string;
    description: string;
    payload?: unknown;
    status?: ApprovalStatus;
  }) {
    // An app compiled against an older SDK still reaches this method with an
    // arbitrary string. Reject it here rather than persist a record no resolver
    // recognises: the row would sit pending forever, and the guardian would have
    // no control that could clear it.
    if (!APPROVAL_TYPES.includes(data.type)) {
      throw new Error(
        `Unknown approval type "${data.type}" — expected one of ${APPROVAL_TYPES.join(", ")}`,
      );
    }
    const id = uuid();
    const now = new Date();
    const status = data.status ?? "pending";
    await this.db.insert(approvals).values({
      id,
      type: data.type,
      status,
      requestedBy: data.requestedBy,
      description: data.description,
      payload: data.payload ?? null,
      executionState: "idle",
      createdAt: now,
      resolvedAt: null,
      resolvedBy: null,
    });
    // After the insert, so a listener that reads the row finds it.
    for (const listener of this.createdListeners) {
      listener({
        id,
        type: data.type,
        status,
        description: data.description,
        payload: data.payload ?? null,
      });
    }
    return id;
  }

  /** Tells `listener` about every approval created from now on. Returns the unsubscribe. */
  onCreated(listener: ApprovalCreatedListener): () => void {
    this.createdListeners.add(listener);
    return () => {
      this.createdListeners.delete(listener);
    };
  }

  /**
   * Whether an approval waits to resume runtime session `sessionId` in the
   * middle of a turn, as of `now`: one still pending that was asked for
   * within {@link APPROVAL_HOLDS_SESSION_MS}, or one approved within it and
   * queued or running. An older one holds nothing, so a request never
   * answered, or an execution a crash left running, cannot keep a chat on
   * one session for good. docs/concepts/sessions.md#continuity-key
   */
  async holdsSession(sessionId: string, now = new Date()): Promise<boolean> {
    const since = new Date(now.getTime() - APPROVAL_HOLDS_SESSION_MS);
    const rows = await this.db
      .select({ id: approvals.id })
      .from(approvals)
      .where(
        and(
          sql`json_extract(${approvals.payload}, '$.sessionId') = ${sessionId}`,
          or(
            and(eq(approvals.status, "pending"), gte(approvals.createdAt, since)),
            and(
              inArray(approvals.executionState, ["queued", "running"]),
              // Timestamps are stored in seconds.
              sql`coalesce(${approvals.resolvedAt}, ${approvals.createdAt}) >= ${Math.floor(since.getTime() / 1000)}`,
            ),
          ),
        ),
      )
      .limit(1);
    return rows.length > 0;
  }

  async findPending() {
    return this.db.select().from(approvals).where(eq(approvals.status, "pending"));
  }

  async findByType(type: ApprovalType) {
    return this.db.select().from(approvals).where(eq(approvals.type, type));
  }

  async findById(id: string) {
    const rows = await this.db.select().from(approvals).where(eq(approvals.id, id));
    return rows[0] ?? null;
  }

  async resolvePending(
    id: string,
    action: ResolveAction,
    resolvedBy: string,
  ): Promise<ResolvePendingResult> {
    const existing = await this.findById(id);
    if (!existing) {
      return { outcome: "not_found" };
    }

    const nextStatus = action === "approve" ? "approved" : "rejected";
    const shouldQueueExecution = action === "approve" && existing.type === "action_execution";

    const updated = await this.db
      .update(approvals)
      .set({
        status: nextStatus,
        resolvedAt: new Date(),
        resolvedBy,
        executionState: shouldQueueExecution ? "queued" : (existing.executionState ?? "idle"),
        executionError: shouldQueueExecution ? null : existing.executionError,
      })
      .where(and(eq(approvals.id, id), eq(approvals.status, "pending")))
      .returning();

    if (updated.length === 0) {
      return {
        outcome: "already_resolved",
        approval: (await this.findById(id)) ?? existing,
      };
    }

    return { outcome: "resolved", approval: updated[0] };
  }

  async claimExecution(id: string): Promise<boolean> {
    const rows = await this.db
      .update(approvals)
      .set({
        executionState: "running",
        executionError: null,
      })
      .where(
        and(
          eq(approvals.id, id),
          eq(approvals.status, "approved"),
          eq(approvals.executionState, "queued"),
        ),
      )
      .returning({ id: approvals.id });
    return rows.length > 0;
  }

  async markExecuted(id: string) {
    await this.db
      .update(approvals)
      .set({
        executedAt: new Date(),
        executionState: "succeeded",
        executionError: null,
      })
      .where(eq(approvals.id, id));
  }

  async markExecutionFailed(id: string, error: string) {
    await this.db
      .update(approvals)
      .set({
        executionState: "failed",
        executionError: error,
      })
      .where(eq(approvals.id, id));
  }

  /** Returns rootExecutionIds from action_execution approvals that are not yet in a terminal state. */
  async findActiveRootExecutionIds(): Promise<string[]> {
    const rows = await this.db
      .select({ payload: approvals.payload })
      .from(approvals)
      .where(activeActionExecutionApproval());
    const ids: string[] = [];
    for (const row of rows) {
      const payload = row.payload as Record<string, unknown> | null;
      if (payload && typeof payload.rootExecutionId === "string") {
        ids.push(payload.rootExecutionId);
      }
    }
    return ids;
  }

  /** Returns the args stored by active action-execution approvals for `actionName`. */
  async findActiveActionArgs(actionName: string): Promise<Record<string, unknown>[]> {
    const rows = await this.db
      .select({ payload: approvals.payload })
      .from(approvals)
      .where(activeActionExecutionApproval());
    return rows.flatMap(({ payload }) => {
      if (!payload || typeof payload !== "object" || Array.isArray(payload)) return [];
      const record = payload as Record<string, unknown>;
      const args = record.args;
      if (
        record.actionName !== actionName ||
        !args ||
        typeof args !== "object" ||
        Array.isArray(args)
      ) {
        return [];
      }
      return [args as Record<string, unknown>];
    });
  }

  async retryFailedExecution(id: string): Promise<RetryExecutionResult> {
    const existing = await this.findById(id);
    if (!existing) {
      return { outcome: "not_found" };
    }

    const rows = await this.db
      .update(approvals)
      .set({
        executionState: "queued",
        executionError: null,
        executedAt: null,
      })
      .where(
        and(
          eq(approvals.id, id),
          eq(approvals.type, "action_execution"),
          eq(approvals.status, "approved"),
          eq(approvals.executionState, "failed"),
        ),
      )
      .returning();

    if (rows.length === 0) {
      return {
        outcome: "not_retryable",
        approval: (await this.findById(id)) ?? existing,
      };
    }

    return { outcome: "queued", approval: rows[0] };
  }
}
