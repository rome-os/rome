import { and, asc, eq, isNull, or, gt, sql } from "drizzle-orm";
import type { AppConnectionErrorBody, AppConnectionResourceConstraint } from "@rome-os/app-runtime";
import { appConnectionAccess, appConnectionAudit, appConnectionInvocations } from "../schema.js";
import type { DrizzleDb } from "../index.js";

export type AppConnectionApproval = "required" | "not_required";
export type AppConnectionInvocationStatus =
  | "ready"
  | "pending_approval"
  | "running"
  | "succeeded"
  | "failed"
  | "rejected"
  | "outcome_unknown";

export interface AppConnectionAccessRecord {
  appId: string;
  connectionId: string;
  identity: string;
  operation: string;
  approval: AppConnectionApproval;
  constraints: AppConnectionResourceConstraint[];
  expiresAt: Date | null;
  revision: number;
  revokedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export type AppConnectionInvocationRecord = typeof appConnectionInvocations.$inferSelect;

function toAccessRecord(row: typeof appConnectionAccess.$inferSelect): AppConnectionAccessRecord {
  return {
    ...row,
    constraints: row.constraints as AppConnectionResourceConstraint[],
  };
}

export class AppConnectionAccessRepository {
  constructor(private readonly db: DrizzleDb) {}

  async listActiveForApp(appId: string, now = new Date()): Promise<AppConnectionAccessRecord[]> {
    const rows = await this.db
      .select()
      .from(appConnectionAccess)
      .where(
        and(
          eq(appConnectionAccess.appId, appId),
          isNull(appConnectionAccess.revokedAt),
          or(isNull(appConnectionAccess.expiresAt), gt(appConnectionAccess.expiresAt, now)),
        ),
      )
      .orderBy(
        asc(appConnectionAccess.connectionId),
        asc(appConnectionAccess.identity),
        asc(appConnectionAccess.operation),
      );
    return rows.map(toAccessRecord);
  }

  async listActiveForConnection(
    appId: string,
    connectionId: string,
    now = new Date(),
  ): Promise<AppConnectionAccessRecord[]> {
    const rows = await this.db
      .select()
      .from(appConnectionAccess)
      .where(
        and(
          eq(appConnectionAccess.appId, appId),
          eq(appConnectionAccess.connectionId, connectionId),
          isNull(appConnectionAccess.revokedAt),
          or(isNull(appConnectionAccess.expiresAt), gt(appConnectionAccess.expiresAt, now)),
        ),
      )
      .orderBy(asc(appConnectionAccess.identity), asc(appConnectionAccess.operation));
    return rows.map(toAccessRecord);
  }

  async listActiveConnectionIds(
    appId: string,
    after: string,
    limit: number,
    now = new Date(),
  ): Promise<string[]> {
    const rows = await this.db
      .selectDistinct({ connectionId: appConnectionAccess.connectionId })
      .from(appConnectionAccess)
      .where(
        and(
          eq(appConnectionAccess.appId, appId),
          gt(appConnectionAccess.connectionId, after),
          isNull(appConnectionAccess.revokedAt),
          or(isNull(appConnectionAccess.expiresAt), gt(appConnectionAccess.expiresAt, now)),
        ),
      )
      .orderBy(asc(appConnectionAccess.connectionId))
      .limit(limit);
    return rows.map((row) => row.connectionId);
  }

  async get(
    appId: string,
    connectionId: string,
    identity: string,
    operation: string,
  ): Promise<AppConnectionAccessRecord | null> {
    const rows = await this.db
      .select()
      .from(appConnectionAccess)
      .where(
        and(
          eq(appConnectionAccess.appId, appId),
          eq(appConnectionAccess.connectionId, connectionId),
          eq(appConnectionAccess.identity, identity),
          eq(appConnectionAccess.operation, operation),
        ),
      )
      .limit(1);
    return rows[0] ? toAccessRecord(rows[0]) : null;
  }

  async put(input: {
    appId: string;
    connectionId: string;
    identity: string;
    operation: string;
    approval: AppConnectionApproval;
    constraints: AppConnectionResourceConstraint[];
    expiresAt?: Date | null;
  }): Promise<AppConnectionAccessRecord> {
    const now = new Date();
    await this.db
      .insert(appConnectionAccess)
      .values({
        ...input,
        expiresAt: input.expiresAt ?? null,
        revision: 1,
        revokedAt: null,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [
          appConnectionAccess.appId,
          appConnectionAccess.connectionId,
          appConnectionAccess.identity,
          appConnectionAccess.operation,
        ],
        set: {
          approval: input.approval,
          constraints: input.constraints,
          expiresAt: input.expiresAt ?? null,
          revision: sql`${appConnectionAccess.revision} + 1`,
          revokedAt: null,
          updatedAt: now,
        },
      });
    return (await this.get(input.appId, input.connectionId, input.identity, input.operation))!;
  }

  async revoke(
    appId: string,
    connectionId: string,
    identity: string,
    operation: string,
  ): Promise<boolean> {
    const result = await this.db
      .update(appConnectionAccess)
      .set({
        revokedAt: new Date(),
        revision: sql`${appConnectionAccess.revision} + 1`,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(appConnectionAccess.appId, appId),
          eq(appConnectionAccess.connectionId, connectionId),
          eq(appConnectionAccess.identity, identity),
          eq(appConnectionAccess.operation, operation),
          isNull(appConnectionAccess.revokedAt),
        ),
      );
    return Number(result.changes ?? 0) > 0;
  }

  async revokeApp(appId: string): Promise<number> {
    const result = await this.db
      .update(appConnectionAccess)
      .set({
        revokedAt: new Date(),
        revision: sql`${appConnectionAccess.revision} + 1`,
        updatedAt: new Date(),
      })
      .where(and(eq(appConnectionAccess.appId, appId), isNull(appConnectionAccess.revokedAt)));
    return Number(result.changes ?? 0);
  }

  createOrGetInvocation(input: {
    id: string;
    appId: string;
    connectionId: string;
    identity: string;
    operation: string;
    requestIdHash?: string | null;
    inputHash: string;
    input: unknown;
    sideEffects: "read-only" | "write";
    accessRevision: number;
  }): { created: boolean; invocation: AppConnectionInvocationRecord } {
    return this.db.transaction((tx) => {
      if (input.requestIdHash) {
        const existing = tx
          .select()
          .from(appConnectionInvocations)
          .where(
            and(
              eq(appConnectionInvocations.appId, input.appId),
              eq(appConnectionInvocations.requestIdHash, input.requestIdHash),
            ),
          )
          .limit(1)
          .get();
        if (existing) return { created: false, invocation: existing };
      }
      const now = new Date();
      tx.insert(appConnectionInvocations)
        .values({
          ...input,
          requestIdHash: input.requestIdHash ?? null,
          input: input.input ?? null,
          status: "ready",
          errorCode: null,
          createdAt: now,
          updatedAt: now,
        })
        .run();
      return {
        created: true,
        invocation: tx
          .select()
          .from(appConnectionInvocations)
          .where(eq(appConnectionInvocations.id, input.id))
          .get()!,
      };
    });
  }

  async getInvocation(id: string): Promise<AppConnectionInvocationRecord | null> {
    const rows = await this.db
      .select()
      .from(appConnectionInvocations)
      .where(eq(appConnectionInvocations.id, id))
      .limit(1);
    return rows[0] ?? null;
  }

  async updateInvocation(
    id: string,
    status: AppConnectionInvocationStatus,
    errorCode?: AppConnectionErrorBody["code"] | null,
    clearInput = false,
  ): Promise<void> {
    await this.db
      .update(appConnectionInvocations)
      .set({
        status,
        errorCode: errorCode ?? null,
        ...(clearInput ? { input: null } : {}),
        updatedAt: new Date(),
      })
      .where(eq(appConnectionInvocations.id, id));
  }

  async appendAudit(input: {
    appId: string;
    connectionId: string;
    identity: string;
    operation: string;
    accessRevision?: number | null;
    approval: "not_required" | "pending" | "approved" | "rejected";
    executionId: string;
    requestIdHash?: string | null;
    status: string;
  }): Promise<void> {
    await this.db.insert(appConnectionAudit).values({
      ...input,
      accessRevision: input.accessRevision ?? null,
      requestIdHash: input.requestIdHash ?? null,
      createdAt: new Date(),
    });
  }

  async listAuditForApp(appId: string, afterSeq = 0, limit = 100) {
    return await this.db
      .select()
      .from(appConnectionAudit)
      .where(and(eq(appConnectionAudit.appId, appId), gt(appConnectionAudit.seq, afterSeq)))
      .orderBy(asc(appConnectionAudit.seq))
      .limit(limit);
  }
}
