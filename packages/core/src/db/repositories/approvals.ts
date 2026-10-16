import type { PersonMappingRepository } from "./person-mapping.js";
import { STRANGER_PERSON_ID } from "../../constants.js";
import { loadPairingKey, pairingCode, matchesPairingCode } from "../../channels/pairing-code.js";
import { and, eq, or, desc, sql, ne, count, gte, inArray } from "drizzle-orm";
import { v4 as uuid } from "uuid";
import { approvals, channelMappings, connections, connectionGrants } from "../schema.js";
import type { DrizzleDb, SqliteExec } from "../index.js";
import {
  pairingPayload,
  PAIRING_HISTORY_PAGE_SIZE,
  type PairingPayload,
  APPROVAL_TYPES,
  type ApprovalStatus,
  type ApprovalType,
} from "@rome/api-types/approvals";

type ApprovalRow = typeof approvals.$inferSelect;
type ResolveAction = "approve" | "reject";

/** An action_execution approval that can still run or change its root: one
 * pending, or approved and not executed yet. A failed execution stays
 * retryable, so it counts. */
const activeActionApproval = and(
  eq(approvals.type, "action_execution"),
  or(
    eq(approvals.status, "pending"),
    and(
      eq(approvals.status, "approved"),
      inArray(approvals.executionState, ["idle", "queued", "running", "failed"]),
    ),
  ),
);

export type ResolvePendingResult =
  | { outcome: "resolved"; approval: ApprovalRow }
  | { outcome: "not_found" }
  | { outcome: "already_resolved"; approval: ApprovalRow };

export type RetryExecutionResult =
  | { outcome: "queued"; approval: ApprovalRow }
  | { outcome: "not_found" }
  | { outcome: "not_retryable"; approval: ApprovalRow };

export class ApprovalsRepository {
  private pairingKey?: Buffer;
  constructor(
    private db: DrizzleDb,
    private readonly personMappingRepo: PersonMappingRepository,
    private readonly getPairingKey = loadPairingKey,
  ) {}

  supersedePairings(connectionId: string, exec: SqliteExec = this.db) {
    exec
      .update(approvals)
      .set({
        status: "rejected",
        resolvedAt: new Date(),
        resolvedBy: "system:connection-disconnected",
        payload: sql`json_set(${approvals.payload}, '$.resolution', 'superseded')`,
      })
      .where(
        and(
          eq(approvals.type, "person_mapping"),
          eq(approvals.status, "pending"),
          sql`json_extract(${approvals.payload}, '$.action') = 'channel_pairing'`,
          sql`json_extract(${approvals.payload}, '$.connectionId') = ${connectionId}`,
        ),
      )
      .run();
  }

  expirePairings(now = Date.now()) {
    this.db
      .update(approvals)
      .set({
        status: "rejected",
        resolvedAt: new Date(now),
        resolvedBy: "system:expiry",
        payload: sql`json_set(${approvals.payload}, '$.resolution', 'expired')`,
      })
      .where(
        and(
          eq(approvals.type, "person_mapping"),
          eq(approvals.status, "pending"),
          sql`json_extract(${approvals.payload}, '$.action') = 'channel_pairing'`,
          sql`json_extract(${approvals.payload}, '$.expiresAt') <= ${now}`,
        ),
      )
      .run();
  }

  async list(status?: ApprovalStatus, pairingHistoryOffset = 0) {
    this.expirePairings();
    const pairing = and(
      eq(approvals.type, "person_mapping"),
      sql`json_extract(${approvals.payload}, '$.action') = 'channel_pairing'`,
    )!;
    const history = this.db
      .select()
      .from(approvals)
      .where(
        and(
          pairing,
          ne(approvals.status, "pending"),
          status ? eq(approvals.status, status) : undefined,
        ),
      )
      .orderBy(desc(approvals.createdAt), desc(approvals.id))
      .limit(PAIRING_HISTORY_PAGE_SIZE)
      .offset(pairingHistoryOffset)
      .all();
    const current =
      pairingHistoryOffset === 0
        ? this.db
            .select()
            .from(approvals)
            .where(
              and(
                or(eq(approvals.status, "pending"), sql`not coalesce(${pairing}, 0)`),
                status ? eq(approvals.status, status) : undefined,
              ),
            )
            .all()
        : [];
    return [...current, ...history].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  }

  requestAuthorizedPairing(
    input: Parameters<ApprovalsRepository["requestPairing"]>[0],
    requiredGrants: readonly string[],
  ) {
    return this.db.transaction((tx) => {
      const connection = tx
        .select()
        .from(connections)
        .where(and(eq(connections.id, input.connectionId), eq(connections.service, input.channel)))
        .get();
      if (!connection || requiredGrants.length === 0) return null;
      const grants = tx
        .select()
        .from(connectionGrants)
        .where(eq(connectionGrants.custody, input.connectionId))
        .all();
      if (
        !requiredGrants.every((name) =>
          grants.some((g) => g.name === name && g.state === "authorized"),
        )
      )
        return null;
      return this.requestPairing(input);
    });
  }

  requestPairing(
    input: Pick<
      PairingPayload,
      "channel" | "connectionId" | "channelUserId" | "displayName" | "username" | "conversationId"
    >,
    now = Date.now(),
  ) {
    return this.db.transaction((tx) => {
      this.expirePairings(now);
      const mapped = tx
        .select()
        .from(channelMappings)
        .where(
          and(
            eq(channelMappings.channel, input.channel),
            eq(channelMappings.channelUserId, input.channelUserId),
          ),
        )
        .get();
      if (mapped && mapped.personId !== STRANGER_PERSON_ID) return null;
      const previous = tx
        .select()
        .from(approvals)
        .where(
          and(
            eq(approvals.type, "person_mapping"),
            sql`json_extract(${approvals.payload}, '$.action') = 'channel_pairing'`,
            sql`json_extract(${approvals.payload}, '$.channel') = ${input.channel}`,
            sql`json_extract(${approvals.payload}, '$.channelUserId') = ${input.channelUserId}`,
            sql`json_extract(${approvals.payload}, '$.expiresAt') > ${now}`,
            sql`coalesce(json_extract(${approvals.payload}, '$.resolution'), '') != 'superseded'`,
          ),
        )
        .orderBy(desc(approvals.createdAt))
        .get();
      if (previous) {
        const payload = pairingPayload(previous)!;
        if (previous.status !== "pending" && payload.resolution !== "superseded") return null;
        if (previous.status === "pending" && payload.connectionId !== input.connectionId) {
          tx.update(approvals)
            .set({
              status: "rejected",
              resolvedAt: new Date(now),
              resolvedBy: "system:connection-replaced",
              payload: { ...payload, resolution: "superseded" },
            })
            .where(eq(approvals.id, previous.id))
            .run();
        } else if (previous.status === "pending") {
          const guide = now - payload.lastGuidanceAt >= 30_000;
          const displayName = input.displayName.trim();
          const hasDisplayName =
            displayName.length > 0 &&
            displayName !== input.channelUserId &&
            !(input.channel === "feishu" && displayName === "Feishu User");
          const updated = {
            ...payload,
            displayName: hasDisplayName ? displayName : payload.displayName,
            username: input.username,
            ...(input.conversationId ? { conversationId: input.conversationId } : {}),
            lastGuidanceAt: guide ? now : payload.lastGuidanceAt,
          };
          tx.update(approvals).set({ payload: updated }).where(eq(approvals.id, previous.id)).run();
          return { approval: { ...previous, payload: updated }, guide };
        }
      }
      const sameConnection = and(
        eq(approvals.type, "person_mapping"),
        sql`json_extract(${approvals.payload}, '$.action') = 'channel_pairing'`,
        sql`json_extract(${approvals.payload}, '$.connectionId') = ${input.connectionId}`,
      );
      const pendingCount = tx
        .select({ value: count() })
        .from(approvals)
        .where(and(sameConnection, eq(approvals.status, "pending")))
        .get()!.value;
      const dailyCount = tx
        .select({ value: count() })
        .from(approvals)
        .where(and(sameConnection, gte(approvals.createdAt, new Date(now - 86_400_000))))
        .get()!.value;
      if (pendingCount >= 20 || dailyCount >= 100) return null;
      const payload: PairingPayload = {
        ...input,
        action: "channel_pairing",
        expiresAt: now + 10 * 60_000,
        failedAttempts: 0,
        lastGuidanceAt: now,
      };
      const approval = tx
        .insert(approvals)
        .values({
          id: uuid(),
          type: "person_mapping",
          status: "pending",
          requestedBy: `${input.channel}:${input.channelUserId}`,
          description: `Pair ${input.displayName || input.channelUserId} on ${input.channel}`,
          payload,
          createdAt: new Date(now),
          executionState: "idle",
        })
        .returning()
        .get();
      return { approval, guide: true };
    });
  }

  async pairingCode(id: string): Promise<string | null> {
    const approval = await this.findById(id);
    const payload = approval && pairingPayload(approval);
    if (!approval || !payload || approval.status !== "pending" || payload.failedAttempts >= 5)
      return null;
    return pairingCode((this.pairingKey ??= this.getPairingKey()), id);
  }

  verifyPairing(input: {
    connectionId: string;
    channel: string;
    channelUserId: string;
    code: string;
  }) {
    return this.db.transaction(() => {
      this.expirePairings();
      const approval = this.db
        .select()
        .from(approvals)
        .where(
          and(
            eq(approvals.status, "pending"),
            eq(approvals.type, "person_mapping"),
            sql`json_extract(${approvals.payload}, '$.action') = 'channel_pairing'`,
            sql`json_extract(${approvals.payload}, '$.connectionId') = ${input.connectionId}`,
            sql`json_extract(${approvals.payload}, '$.channel') = ${input.channel}`,
            sql`json_extract(${approvals.payload}, '$.channelUserId') = ${input.channelUserId}`,
          ),
        )
        .get();
      const payload = approval && pairingPayload(approval);
      if (!approval || !payload || payload.failedAttempts >= 5)
        return { outcome: "invalid_code" as const };
      if (
        !matchesPairingCode(
          pairingCode((this.pairingKey ??= this.getPairingKey()), approval.id),
          input.code,
        )
      ) {
        this.db
          .update(approvals)
          .set({ payload: { ...payload, failedAttempts: payload.failedAttempts + 1 } })
          .where(eq(approvals.id, approval.id))
          .run();
        return { outcome: "invalid_code" as const, notify: true };
      }
      return this.resolvePairing(
        approval.id,
        "approve",
        `${input.channel}:${input.channelUserId}`,
        "verification_code",
      );
    });
  }

  private resolvePairing(
    id: string,
    action: ResolveAction,
    actor: string,
    method: "web" | "verification_code",
  ): ResolvePendingResult {
    return this.db.transaction((tx) => {
      this.expirePairings();
      const approval = tx.select().from(approvals).where(eq(approvals.id, id)).get();
      if (!approval) return { outcome: "not_found" };
      const payload = pairingPayload(approval);
      if (!payload || approval.status !== "pending")
        return { outcome: "already_resolved", approval };
      let resolution: PairingPayload["resolution"] = action === "approve" ? method : "rejected";
      if (action === "approve") {
        if (
          !this.personMappingRepo.writeGuardianPairing(
            tx,
            payload.channel,
            payload.channelUserId,
            payload.displayName,
          )
        ) {
          resolution = "account_linked";
          action = "reject";
        }
      }

      const resolved = tx
        .update(approvals)
        .set({
          status: action === "approve" ? "approved" : "rejected",
          resolvedAt: new Date(),
          resolvedBy: actor,
          payload: { ...payload, resolution },
        })
        .where(and(eq(approvals.id, id), eq(approvals.status, "pending")))
        .returning()
        .get()!;
      return { outcome: "resolved", approval: resolved };
    });
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
    await this.db.insert(approvals).values({
      id,
      type: data.type,
      status: data.status ?? "pending",
      requestedBy: data.requestedBy,
      description: data.description,
      payload: data.payload ?? null,
      executionState: "idle",
      createdAt: now,
      resolvedAt: null,
      resolvedBy: null,
    });
    return id;
  }

  async findPending() {
    this.expirePairings();
    return this.db.select().from(approvals).where(eq(approvals.status, "pending"));
  }

  async findByType(type: ApprovalType) {
    this.expirePairings();
    return this.db.select().from(approvals).where(eq(approvals.type, type));
  }

  async findById(id: string) {
    this.expirePairings();
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

    if (pairingPayload(existing)) {
      return this.resolvePairing(id, action, resolvedBy, "web");
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
      .where(activeActionApproval);
    const ids: string[] = [];
    for (const row of rows) {
      const payload = row.payload as Record<string, unknown> | null;
      if (payload && typeof payload.rootExecutionId === "string") {
        ids.push(payload.rootExecutionId);
      }
    }
    return ids;
  }

  /** Whether an action_execution approval for the root can still run or change
   * it: one pending, or approved and not executed yet. A failed execution
   * stays retryable, so it counts unless `countFailed` is false. */
  hasActiveApprovalForRoot(
    rootExecutionId: string,
    { countFailed = true }: { countFailed?: boolean } = {},
  ): boolean {
    const row = this.db
      .select({ id: approvals.id })
      .from(approvals)
      .where(
        and(
          activeActionApproval,
          sql`json_extract(${approvals.payload}, '$.rootExecutionId') = ${rootExecutionId}`,
          countFailed ? undefined : ne(approvals.executionState, "failed"),
        ),
      )
      .limit(1)
      .get();
    return row !== undefined;
  }

  /** Whether the guardian rejected any action_execution approval for the root. */
  hasRejectedApprovalForRoot(rootExecutionId: string): boolean {
    const row = this.db
      .select({ id: approvals.id })
      .from(approvals)
      .where(
        and(
          eq(approvals.type, "action_execution"),
          eq(approvals.status, "rejected"),
          sql`json_extract(${approvals.payload}, '$.rootExecutionId') = ${rootExecutionId}`,
        ),
      )
      .limit(1)
      .get();
    return row !== undefined;
  }

  /**
   * Fails every approved action_execution approval a stopped process left
   * `queued` or `running`, so the guardian can retry it. Returns how many it
   * failed, and the roots the `running` ones were replaying. Call only at
   * boot, before any approval executes: nothing claims or runs one then.
   */
  async failInterruptedExecutions(): Promise<{ failed: number; replayedRoots: string[] }> {
    const fail = (state: "queued" | "running", error: string) =>
      this.db
        .update(approvals)
        .set({ executionState: "failed", executionError: error })
        .where(
          and(
            eq(approvals.type, "action_execution"),
            eq(approvals.status, "approved"),
            eq(approvals.executionState, state),
          ),
        )
        .returning({ payload: approvals.payload });
    const unclaimed = await fail("queued", "Rome stopped before the approved action started");
    const started = await fail("running", "Rome stopped while the approved action was running");
    const replayedRoots = new Set<string>();
    for (const row of started) {
      const rootExecutionId = (row.payload as Record<string, unknown> | null)?.rootExecutionId;
      if (typeof rootExecutionId === "string") replayedRoots.add(rootExecutionId);
    }
    return { failed: unclaimed.length + started.length, replayedRoots: [...replayedRoots] };
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
