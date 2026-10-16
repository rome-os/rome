import { and, eq, inArray, notInArray } from "drizzle-orm";
import { webhookInvocations } from "../schema.js";
import type { DrizzleDb } from "../index.js";
import type { ActionResult } from "../../actions/types.js";

export type WebhookInvocationStatus =
  | "accepted"
  | "running"
  | "success"
  | "error"
  | "pending_approval"
  | "cancelled";

export type WebhookCallbackStatus = "not_requested" | "pending" | "succeeded" | "failed";

/** Statuses a row holds only while the run that the webhook route started is live. */
const UNSETTLED_STATUSES = ["accepted", "running"] as const;

export interface WebhookInvocationOutcome {
  status: WebhookInvocationStatus;
  error: string | null;
  finishedAt: Date;
}

export interface WebhookInvocationRecord {
  executionId: string;
  actionName: string;
  args: Record<string, unknown> | null;
  callbackUrl: string | null;
  status: WebhookInvocationStatus;
  result: ActionResult | null;
  error: string | null;
  callbackStatus: WebhookCallbackStatus;
  callbackAttemptedAt: Date | null;
  callbackDeliveredAt: Date | null;
  callbackResponseStatus: number | null;
  callbackError: string | null;
  createdAt: Date;
  updatedAt: Date;
  finishedAt: Date | null;
}

export class WebhookInvocationsRepository {
  constructor(private db: DrizzleDb) {}

  async createAccepted(data: {
    executionId: string;
    actionName: string;
    args: Record<string, unknown>;
    callbackUrl?: string;
    createdAt?: Date;
  }): Promise<void> {
    const now = data.createdAt ?? new Date();
    await this.db.insert(webhookInvocations).values({
      executionId: data.executionId,
      actionName: data.actionName,
      args: data.args,
      callbackUrl: data.callbackUrl ?? null,
      status: "accepted",
      result: null,
      error: null,
      callbackStatus: data.callbackUrl ? "pending" : "not_requested",
      callbackAttemptedAt: null,
      callbackDeliveredAt: null,
      callbackResponseStatus: null,
      callbackError: null,
      createdAt: now,
      updatedAt: now,
      finishedAt: null,
    });
  }

  async findByExecutionId(executionId: string): Promise<WebhookInvocationRecord | null> {
    const rows = await this.db
      .select()
      .from(webhookInvocations)
      .where(eq(webhookInvocations.executionId, executionId))
      .limit(1);
    const row = rows[0];
    if (!row) return null;
    return {
      executionId: row.executionId,
      actionName: row.actionName,
      args: (row.args as Record<string, unknown> | null) ?? null,
      callbackUrl: row.callbackUrl ?? null,
      status: row.status as WebhookInvocationStatus,
      result: (row.result as ActionResult | null) ?? null,
      error: row.error ?? null,
      callbackStatus: row.callbackStatus as WebhookCallbackStatus,
      callbackAttemptedAt: row.callbackAttemptedAt ?? null,
      callbackDeliveredAt: row.callbackDeliveredAt ?? null,
      callbackResponseStatus: row.callbackResponseStatus ?? null,
      callbackError: row.callbackError ?? null,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      finishedAt: row.finishedAt ?? null,
    };
  }

  async update(
    executionId: string,
    data: {
      status?: WebhookInvocationStatus;
      result?: ActionResult | null;
      error?: string | null;
      callbackStatus?: WebhookCallbackStatus;
      callbackAttemptedAt?: Date | null;
      callbackDeliveredAt?: Date | null;
      callbackResponseStatus?: number | null;
      callbackError?: string | null;
      finishedAt?: Date | null;
      updatedAt?: Date;
    },
  ): Promise<void> {
    await this.db
      .update(webhookInvocations)
      .set({
        ...(data.status !== undefined ? { status: data.status } : {}),
        ...(data.result !== undefined ? { result: data.result } : {}),
        ...(data.error !== undefined ? { error: data.error } : {}),
        ...(data.callbackStatus !== undefined ? { callbackStatus: data.callbackStatus } : {}),
        ...(data.callbackAttemptedAt !== undefined
          ? { callbackAttemptedAt: data.callbackAttemptedAt }
          : {}),
        ...(data.callbackDeliveredAt !== undefined
          ? { callbackDeliveredAt: data.callbackDeliveredAt }
          : {}),
        ...(data.callbackResponseStatus !== undefined
          ? { callbackResponseStatus: data.callbackResponseStatus }
          : {}),
        ...(data.callbackError !== undefined ? { callbackError: data.callbackError } : {}),
        ...(data.finishedAt !== undefined ? { finishedAt: data.finishedAt } : {}),
        updatedAt: data.updatedAt ?? new Date(),
      })
      .where(eq(webhookInvocations.executionId, executionId));
  }

  /**
   * Gives every `accepted` or `running` invocation the outcome `outcomeFor`
   * returns for its execution id, and returns how many it settled. `result`
   * becomes null. Call only at boot, before the webhook route can start a run:
   * a row settled here must not belong to a live run.
   */
  async settleInterrupted(
    now: Date,
    outcomeFor: (executionId: string) => Promise<WebhookInvocationOutcome>,
  ): Promise<number> {
    const rows = await this.db
      .select({ executionId: webhookInvocations.executionId })
      .from(webhookInvocations)
      .where(inArray(webhookInvocations.status, [...UNSETTLED_STATUSES]));
    for (const { executionId } of rows) {
      const outcome = await outcomeFor(executionId);
      await this.db
        .update(webhookInvocations)
        .set({
          status: outcome.status,
          result: null,
          error: outcome.error,
          finishedAt: outcome.finishedAt,
          updatedAt: now,
        })
        .where(
          and(
            eq(webhookInvocations.executionId, executionId),
            inArray(webhookInvocations.status, [...UNSETTLED_STATUSES]),
          ),
        );
    }
    return rows.length;
  }

  /** Execution ids of settled invocations whose requested callback was never attempted, oldest first. */
  async listUndeliveredCallbacks(): Promise<string[]> {
    const rows = await this.db
      .select({ executionId: webhookInvocations.executionId })
      .from(webhookInvocations)
      .where(
        and(
          eq(webhookInvocations.callbackStatus, "pending"),
          notInArray(webhookInvocations.status, [...UNSETTLED_STATUSES]),
        ),
      )
      .orderBy(webhookInvocations.createdAt);
    return rows.map((row) => row.executionId);
  }
}
