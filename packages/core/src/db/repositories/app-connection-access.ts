import { and, asc, eq, gt, inArray, isNull, lt, or, sql } from "drizzle-orm";
import type { AppConnectionErrorBody, AppConnectionResourceConstraint } from "@rome-os/app-runtime";
import {
  appConnectionAccess,
  appConnectionAudit,
  appConnectionInvocations,
  connectionGrants,
} from "../schema.js";
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
  grantConferralEpoch: string;
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
      .innerJoin(connectionGrants, eq(connectionGrants.custody, appConnectionAccess.connectionId))
      .where(
        and(
          eq(appConnectionAccess.appId, appId),
          or(
            eq(connectionGrants.conferralEpoch, appConnectionAccess.grantConferralEpoch),
            and(
              eq(connectionGrants.state, "unauthorized"),
              isNull(connectionGrants.conferralEpoch),
            ),
          ),
          gt(appConnectionAccess.connectionId, after),
          isNull(appConnectionAccess.revokedAt),
          or(isNull(appConnectionAccess.expiresAt), gt(appConnectionAccess.expiresAt, now)),
        ),
      )
      .orderBy(asc(appConnectionAccess.connectionId))
      .limit(limit);
    return rows.map((row) => row.connectionId);
  }

  async listUnrevokedAppIds(): Promise<string[]> {
    const rows = await this.db
      .selectDistinct({ appId: appConnectionAccess.appId })
      .from(appConnectionAccess)
      .where(isNull(appConnectionAccess.revokedAt));
    return rows.map((row) => row.appId);
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
    grantConferralEpoch: string;
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
          grantConferralEpoch: input.grantConferralEpoch,
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
    return this.db.transaction((tx) => {
      const now = new Date();
      const pending = tx
        .select()
        .from(appConnectionInvocations)
        .where(
          and(
            eq(appConnectionInvocations.appId, appId),
            inArray(appConnectionInvocations.status, ["ready", "pending_approval"]),
          ),
        )
        .all();
      const result = tx
        .update(appConnectionAccess)
        .set({
          revokedAt: now,
          revision: sql`${appConnectionAccess.revision} + 1`,
          updatedAt: now,
        })
        .where(and(eq(appConnectionAccess.appId, appId), isNull(appConnectionAccess.revokedAt)))
        .run();
      tx.update(appConnectionInvocations)
        .set({ status: "rejected", errorCode: "access_denied", input: null, updatedAt: now })
        .where(
          and(
            eq(appConnectionInvocations.appId, appId),
            inArray(appConnectionInvocations.status, ["ready", "pending_approval"]),
          ),
        )
        .run();
      tx.update(appConnectionInvocations)
        .set({ input: null, updatedAt: now })
        .where(
          and(
            eq(appConnectionInvocations.appId, appId),
            eq(appConnectionInvocations.status, "running"),
          ),
        )
        .run();
      for (const invocation of pending) {
        tx.insert(appConnectionAudit)
          .values({
            appId: invocation.appId,
            connectionId: invocation.connectionId,
            identity: invocation.identity,
            operation: invocation.operation,
            accessRevision: invocation.accessRevision,
            approval: "rejected",
            executionId: invocation.id,
            requestIdHash: invocation.requestIdHash,
            status: "access_denied",
            createdAt: now,
          })
          .run();
      }
      return Number(result.changes ?? 0);
    });
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

  async transitionInvocation(
    id: string,
    from: AppConnectionInvocationStatus[],
    status: AppConnectionInvocationStatus,
    errorCode?: AppConnectionErrorBody["code"] | null,
    clearInput = false,
  ): Promise<boolean> {
    const result = await this.db
      .update(appConnectionInvocations)
      .set({
        status,
        errorCode: errorCode ?? null,
        ...(clearInput ? { input: null } : {}),
        updatedAt: new Date(),
      })
      .where(
        and(eq(appConnectionInvocations.id, id), inArray(appConnectionInvocations.status, from)),
      );
    return Number(result.changes ?? 0) > 0;
  }

  claimInvocationWithPolicy(
    invocation: AppConnectionInvocationRecord,
    expectedStatus: "ready" | "pending_approval",
    approval: AppConnectionApproval,
    now = new Date(),
  ): boolean {
    return this.db.transaction((tx) => {
      const policy = tx
        .select()
        .from(appConnectionAccess)
        .where(
          and(
            eq(appConnectionAccess.appId, invocation.appId),
            eq(appConnectionAccess.connectionId, invocation.connectionId),
            eq(appConnectionAccess.identity, invocation.identity),
            eq(appConnectionAccess.operation, invocation.operation),
          ),
        )
        .limit(1)
        .get();
      const grant = tx
        .select({ state: connectionGrants.state, conferralEpoch: connectionGrants.conferralEpoch })
        .from(connectionGrants)
        .where(eq(connectionGrants.custody, invocation.connectionId))
        .limit(1)
        .get();
      if (!policyCurrentForInvocation(policy, grant, invocation, approval, now)) return false;
      const result = tx
        .update(appConnectionInvocations)
        .set({ status: "running", errorCode: null, updatedAt: now })
        .where(
          and(
            eq(appConnectionInvocations.id, invocation.id),
            eq(appConnectionInvocations.status, expectedStatus),
          ),
        )
        .run();
      return Number(result.changes ?? 0) > 0;
    });
  }

  isInvocationPolicyCurrent(
    invocation: AppConnectionInvocationRecord,
    approval: AppConnectionApproval,
    now = new Date(),
  ): boolean {
    const current = this.db
      .select({ policy: appConnectionAccess, grant: connectionGrants })
      .from(appConnectionAccess)
      .innerJoin(connectionGrants, eq(connectionGrants.custody, appConnectionAccess.connectionId))
      .where(
        and(
          eq(appConnectionAccess.appId, invocation.appId),
          eq(appConnectionAccess.connectionId, invocation.connectionId),
          eq(appConnectionAccess.identity, invocation.identity),
          eq(appConnectionAccess.operation, invocation.operation),
        ),
      )
      .limit(1)
      .get();
    return Boolean(
      current &&
        current.grant.state !== "unauthorized" &&
        policyCurrentForInvocation(current.policy, current.grant, invocation, approval, now),
    );
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

  async pruneExpiredData(before: Date): Promise<{ invocations: number; audits: number }> {
    return this.db.transaction((tx) => {
      const now = new Date();
      tx.update(appConnectionInvocations)
        .set({ status: "rejected", errorCode: "access_denied", input: null, updatedAt: now })
        .where(
          and(
            inArray(appConnectionInvocations.status, ["ready", "pending_approval"]),
            lt(appConnectionInvocations.updatedAt, before),
          ),
        )
        .run();
      tx.update(appConnectionInvocations)
        .set({
          status: "outcome_unknown",
          errorCode: "outcome_unknown",
          input: null,
          updatedAt: now,
        })
        .where(
          and(
            eq(appConnectionInvocations.status, "running"),
            lt(appConnectionInvocations.updatedAt, before),
          ),
        )
        .run();
      const invocations = tx
        .delete(appConnectionInvocations)
        .where(
          and(
            inArray(appConnectionInvocations.status, [
              "succeeded",
              "failed",
              "rejected",
              "outcome_unknown",
            ]),
            lt(appConnectionInvocations.updatedAt, before),
          ),
        )
        .run();
      const audits = tx
        .delete(appConnectionAudit)
        .where(lt(appConnectionAudit.createdAt, before))
        .run();
      return {
        invocations: Number(invocations.changes ?? 0),
        audits: Number(audits.changes ?? 0),
      };
    });
  }
}

function policyCurrentForInvocation(
  policy: typeof appConnectionAccess.$inferSelect | undefined,
  grant: Pick<typeof connectionGrants.$inferSelect, "state" | "conferralEpoch"> | undefined,
  invocation: AppConnectionInvocationRecord,
  approval: AppConnectionApproval,
  now: Date,
): boolean {
  return Boolean(
    policy &&
      grant &&
      policy.revokedAt === null &&
      (policy.expiresAt === null || policy.expiresAt > now) &&
      policy.revision === invocation.accessRevision &&
      policy.approval === approval &&
      ((grant.conferralEpoch !== null && policy.grantConferralEpoch === grant.conferralEpoch) ||
        (grant.state === "unauthorized" && grant.conferralEpoch === null)),
  );
}
