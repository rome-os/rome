import { and, asc, eq, gt, inArray, isNull, lt, or, sql } from "drizzle-orm";
import type { AppConnectionErrorBody, AppConnectionResourceConstraint } from "@rome-os/app-runtime";
import { KeyedMutex } from "../../lib/keyed-mutex.js";
import {
  appConnectionAccess,
  appConnectionAudit,
  appConnectionInvocations,
  connectionGrants,
} from "../schema.js";
import type { DrizzleDb, DrizzleTx } from "../index.js";

export type AppConnectionApproval = "required" | "not_required";
export type AppConnectionSideEffects = "read-only" | "write";
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
  sideEffects: AppConnectionSideEffects;
  approval: AppConnectionApproval;
  constraints: AppConnectionResourceConstraint[];
  expiresAt: Date | null;
  grantEpoch: string;
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

function rejectPendingInvocations(
  tx: DrizzleTx,
  scope: {
    appId: string;
    connectionId?: string;
    identity?: string;
    operation?: string;
    beforeRevision?: number;
  },
  now: Date,
): void {
  const matchesScope = and(
    eq(appConnectionInvocations.appId, scope.appId),
    scope.connectionId === undefined
      ? undefined
      : eq(appConnectionInvocations.connectionId, scope.connectionId),
    scope.identity === undefined
      ? undefined
      : eq(appConnectionInvocations.identity, scope.identity),
    scope.operation === undefined
      ? undefined
      : eq(appConnectionInvocations.operation, scope.operation),
    scope.beforeRevision === undefined
      ? undefined
      : lt(appConnectionInvocations.accessRevision, scope.beforeRevision),
  );
  const pending = tx
    .select()
    .from(appConnectionInvocations)
    .where(
      and(matchesScope, inArray(appConnectionInvocations.status, ["ready", "pending_approval"])),
    )
    .all();
  tx.update(appConnectionInvocations)
    .set({ status: "rejected", errorCode: "access_denied", input: null, updatedAt: now })
    .where(
      and(matchesScope, inArray(appConnectionInvocations.status, ["ready", "pending_approval"])),
    )
    .run();
  tx.update(appConnectionInvocations)
    .set({ input: null, updatedAt: now })
    .where(and(matchesScope, eq(appConnectionInvocations.status, "running")))
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
}

export class AppConnectionAccessRepository {
  private readonly appLifecycle = new KeyedMutex();

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
            eq(connectionGrants.grantEpoch, appConnectionAccess.grantEpoch),
            and(eq(connectionGrants.state, "unauthorized"), isNull(connectionGrants.grantEpoch)),
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
    sideEffects: AppConnectionSideEffects;
    approval: AppConnectionApproval;
    constraints: AppConnectionResourceConstraint[];
    grantEpoch: string;
    expiresAt?: Date | null;
  }): Promise<AppConnectionAccessRecord> {
    return await this.appLifecycle.runExclusive(input.appId, () => this.putUnlocked(input));
  }

  async putIfAppActive(
    input: Parameters<AppConnectionAccessRepository["put"]>[0],
    isAppActive: () => boolean,
  ): Promise<AppConnectionAccessRecord | null> {
    return await this.appLifecycle.runExclusive(input.appId, async () => {
      if (!isAppActive()) return null;
      return await this.putUnlocked(input);
    });
  }

  private putUnlocked(input: Parameters<AppConnectionAccessRepository["put"]>[0]) {
    const now = new Date();
    return this.db.transaction((tx) => {
      const policy = tx
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
            sideEffects: input.sideEffects,
            approval: input.approval,
            constraints: input.constraints,
            grantEpoch: input.grantEpoch,
            expiresAt: input.expiresAt ?? null,
            revision: sql`${appConnectionAccess.revision} + 1`,
            revokedAt: null,
            updatedAt: now,
          },
        })
        .returning()
        .get();
      rejectPendingInvocations(
        tx,
        {
          appId: input.appId,
          connectionId: input.connectionId,
          identity: input.identity,
          operation: input.operation,
          beforeRevision: policy.revision,
        },
        now,
      );
      return toAccessRecord(policy);
    });
  }

  async revoke(
    appId: string,
    connectionId: string,
    identity: string,
    operation: string,
  ): Promise<boolean> {
    return await this.appLifecycle.runExclusive(appId, () =>
      this.db.transaction((tx) => {
        const now = new Date();
        const result = tx
          .update(appConnectionAccess)
          .set({
            revokedAt: now,
            revision: sql`${appConnectionAccess.revision} + 1`,
            updatedAt: now,
          })
          .where(
            and(
              eq(appConnectionAccess.appId, appId),
              eq(appConnectionAccess.connectionId, connectionId),
              eq(appConnectionAccess.identity, identity),
              eq(appConnectionAccess.operation, operation),
              isNull(appConnectionAccess.revokedAt),
            ),
          )
          .run();
        if (Number(result.changes ?? 0) === 0) return false;
        rejectPendingInvocations(tx, { appId, connectionId, identity, operation }, now);
        return true;
      }),
    );
  }

  async revokeApp(appId: string): Promise<number> {
    return await this.appLifecycle.runExclusive(appId, () => this.revokeAppUnlocked(appId));
  }

  private revokeAppUnlocked(appId: string): number {
    return this.db.transaction((tx) => {
      const now = new Date();
      const result = tx
        .update(appConnectionAccess)
        .set({
          revokedAt: now,
          revision: sql`${appConnectionAccess.revision} + 1`,
          updatedAt: now,
        })
        .where(and(eq(appConnectionAccess.appId, appId), isNull(appConnectionAccess.revokedAt)))
        .run();
      rejectPendingInvocations(tx, { appId }, now);
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
        .select({ state: connectionGrants.state, grantEpoch: connectionGrants.grantEpoch })
        .from(connectionGrants)
        .where(eq(connectionGrants.custody, invocation.connectionId))
        .limit(1)
        .get();
      if (!policyCurrentForInvocation(policy, grant, invocation, approval, now, true)) return false;
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

  async recoverInterruptedInvocations(
    activeApprovalInvocationIds: readonly string[] = [],
    now = new Date(),
  ): Promise<number> {
    return this.db.transaction((tx) => {
      const activeApprovals = new Set(activeApprovalInvocationIds);
      const interrupted = tx
        .select()
        .from(appConnectionInvocations)
        .where(inArray(appConnectionInvocations.status, ["ready", "pending_approval", "running"]))
        .all();
      let recovered = 0;
      for (const invocation of interrupted) {
        if (invocation.status === "pending_approval" && activeApprovals.has(invocation.id)) {
          continue;
        }
        const outcomeUnknown = invocation.status === "running";
        const errorCode = outcomeUnknown ? "outcome_unknown" : "capability_unavailable";
        const result = tx
          .update(appConnectionInvocations)
          .set({
            status: outcomeUnknown ? "outcome_unknown" : "failed",
            errorCode,
            input: null,
            updatedAt: now,
          })
          .where(
            and(
              eq(appConnectionInvocations.id, invocation.id),
              eq(appConnectionInvocations.status, invocation.status),
            ),
          )
          .run();
        if (Number(result.changes ?? 0) === 0) continue;

        const requiredApproval =
          invocation.status === "running" &&
          invocation.sideEffects === "write" &&
          Boolean(
            tx
              .select({ seq: appConnectionAudit.seq })
              .from(appConnectionAudit)
              .where(
                and(
                  eq(appConnectionAudit.appId, invocation.appId),
                  eq(appConnectionAudit.executionId, invocation.id),
                  eq(appConnectionAudit.approval, "pending"),
                ),
              )
              .limit(1)
              .get(),
          );
        tx.insert(appConnectionAudit)
          .values({
            appId: invocation.appId,
            connectionId: invocation.connectionId,
            identity: invocation.identity,
            operation: invocation.operation,
            accessRevision: invocation.accessRevision,
            approval:
              invocation.status === "pending_approval"
                ? "pending"
                : requiredApproval
                  ? "approved"
                  : "not_required",
            executionId: invocation.id,
            requestIdHash: invocation.requestIdHash,
            status: errorCode,
            createdAt: now,
          })
          .run();
        recovered += 1;
      }
      return recovered;
    });
  }

  async pruneExpiredData(before: Date): Promise<{ invocations: number; audits: number }> {
    return this.db.transaction((tx) => {
      const now = new Date();
      const stale = tx
        .select()
        .from(appConnectionInvocations)
        .where(
          and(
            inArray(appConnectionInvocations.status, ["ready", "pending_approval", "running"]),
            lt(appConnectionInvocations.updatedAt, before),
          ),
        )
        .all();
      for (const invocation of stale) {
        const wasRunning = invocation.status === "running";
        const errorCode = wasRunning ? "outcome_unknown" : "access_denied";
        const updated = tx
          .update(appConnectionInvocations)
          .set({
            status: wasRunning ? "outcome_unknown" : "rejected",
            errorCode,
            input: null,
            updatedAt: now,
          })
          .where(
            and(
              eq(appConnectionInvocations.id, invocation.id),
              eq(appConnectionInvocations.status, invocation.status),
            ),
          )
          .run();
        if (Number(updated.changes ?? 0) === 0) continue;

        const resumedAfterApproval =
          wasRunning &&
          invocation.sideEffects === "write" &&
          Boolean(
            tx
              .select({ seq: appConnectionAudit.seq })
              .from(appConnectionAudit)
              .where(
                and(
                  eq(appConnectionAudit.appId, invocation.appId),
                  eq(appConnectionAudit.executionId, invocation.id),
                  eq(appConnectionAudit.approval, "pending"),
                ),
              )
              .limit(1)
              .get(),
          );
        tx.insert(appConnectionAudit)
          .values({
            appId: invocation.appId,
            connectionId: invocation.connectionId,
            identity: invocation.identity,
            operation: invocation.operation,
            accessRevision: invocation.accessRevision,
            approval:
              invocation.status === "pending_approval"
                ? "pending"
                : resumedAfterApproval
                  ? "approved"
                  : "not_required",
            executionId: invocation.id,
            requestIdHash: invocation.requestIdHash,
            status: errorCode,
            createdAt: now,
          })
          .run();
      }
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
            or(
              eq(appConnectionInvocations.sideEffects, "read-only"),
              lt(appConnectionInvocations.updatedAt, before),
            ),
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
  grant: Pick<typeof connectionGrants.$inferSelect, "state" | "grantEpoch"> | undefined,
  invocation: AppConnectionInvocationRecord,
  approval: AppConnectionApproval,
  now: Date,
  allowDegraded = false,
): boolean {
  return Boolean(
    policy &&
      grant &&
      (grant.state === "authorized" || (allowDegraded && grant.state === "degraded")) &&
      policy.revokedAt === null &&
      (policy.expiresAt === null || policy.expiresAt > now) &&
      policy.revision === invocation.accessRevision &&
      policy.sideEffects === invocation.sideEffects &&
      policy.approval === approval &&
      grant.grantEpoch !== null &&
      policy.grantEpoch === grant.grantEpoch,
  );
}
