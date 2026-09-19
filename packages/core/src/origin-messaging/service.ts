import { createHash, randomBytes } from "node:crypto";
import { and, eq, lt } from "drizzle-orm";
import type {
  MessageReceipt,
  OriginCaptureOutcome,
  OriginMessageReceipt,
  OriginReference,
  OriginSendOutcome,
} from "@rome-os/app-runtime";
import type { DrizzleDb } from "../db/index.js";
import { originRoutes, originSendAttempts } from "../db/schema.js";

const ORIGIN_REFERENCE_PREFIX = "or1_";
const ORIGIN_REFERENCE_PATTERN = /^or1_[A-Za-z0-9_-]{43}$/;
const ORIGIN_REFERENCE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const ORIGIN_RECORD_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const SEND_ATTEMPT_RETENTION_MS = ORIGIN_REFERENCE_TTL_MS + ORIGIN_RECORD_RETENTION_MS;
const MAX_TEXT_LENGTH = 20_000;
const MAX_IDEMPOTENCY_KEY_LENGTH = 200;

export interface ExactOriginRoute {
  connectionId: string;
  service: string;
  conversationId: string;
}

type StoredOutcome = OriginSendOutcome;

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function referenceHash(reference: string): string {
  return sha256(reference);
}

function payloadHash(text: string): string {
  return sha256(JSON.stringify({ text }));
}

function publicOutcome(outcome: StoredOutcome, isDeduplicated: boolean): OriginSendOutcome {
  switch (outcome.status) {
    case "accepted":
      return {
        status: "accepted",
        deduplicated: isDeduplicated,
        receipt: sanitizeReceipt(outcome.receipt),
      };
    case "unavailable":
      return {
        status: "unavailable",
        deduplicated: isDeduplicated,
        reason: "origin_unavailable",
      };
    case "invalid_request":
      if (
        outcome.reason !== "invalid_text" &&
        outcome.reason !== "invalid_idempotency_key" &&
        outcome.reason !== "idempotency_conflict"
      ) {
        return { status: "indeterminate", deduplicated: isDeduplicated };
      }
      return {
        status: "invalid_request",
        deduplicated: isDeduplicated,
        reason: outcome.reason,
      };
    case "indeterminate":
      return { status: "indeterminate", deduplicated: isDeduplicated };
  }
}

function sanitizeReceipt(receipt: MessageReceipt | OriginMessageReceipt): OriginMessageReceipt {
  if (!receipt || typeof receipt !== "object") return {};
  return {
    ...(typeof receipt.messageId === "string" ? { messageId: receipt.messageId } : {}),
    ...(Array.isArray(receipt.parts)
      ? {
          parts: receipt.parts
            .filter(
              (part): part is { messageId: string; kind: string } =>
                typeof part?.messageId === "string" && typeof part?.kind === "string",
            )
            .map((part) => ({ messageId: part.messageId, kind: part.kind })),
        }
      : {}),
  };
}

export interface ExactOriginTransport {
  preflight(route: ExactOriginRoute): Promise<"available" | "unavailable">;
  send(route: ExactOriginRoute, text: string): Promise<MessageReceipt>;
}

export class OriginMessagingRepository {
  constructor(private readonly db: DrizzleDb) {}

  createRoute(input: {
    reference: OriginReference;
    appId: string;
    route: ExactOriginRoute;
    createdAt: Date;
    expiresAt: Date;
  }): void {
    this.db
      .insert(originRoutes)
      .values({
        refHash: referenceHash(input.reference),
        appId: input.appId,
        connectionId: input.route.connectionId,
        service: input.route.service,
        conversationId: input.route.conversationId,
        status: "active",
        expiresAt: input.expiresAt,
        createdAt: input.createdAt,
      })
      .run();
  }

  findRoute(reference: OriginReference, appId: string) {
    return (
      this.db
        .select()
        .from(originRoutes)
        .where(
          and(eq(originRoutes.refHash, referenceHash(reference)), eq(originRoutes.appId, appId)),
        )
        .get() ?? null
    );
  }

  revoke(reference: OriginReference, appId: string): boolean {
    const result = this.db
      .update(originRoutes)
      .set({ status: "revoked" })
      .where(and(eq(originRoutes.refHash, referenceHash(reference)), eq(originRoutes.appId, appId)))
      .run();
    return result.changes > 0;
  }

  claimAttempt(input: {
    appId: string;
    refHash: string;
    idempotencyKey: string;
    payloadHash: string;
    now: Date;
  }):
    | { claimed: true }
    | { claimed: false; conflict: true }
    | { claimed: false; conflict: false; outcome: StoredOutcome } {
    return this.db.transaction(
      (tx) => {
        const existing = tx
          .select()
          .from(originSendAttempts)
          .where(
            and(
              eq(originSendAttempts.appId, input.appId),
              eq(originSendAttempts.refHash, input.refHash),
              eq(originSendAttempts.idempotencyKey, input.idempotencyKey),
            ),
          )
          .get();
        if (existing) {
          if (existing.payloadHash !== input.payloadHash) {
            return { claimed: false as const, conflict: true as const };
          }
          return {
            claimed: false as const,
            conflict: false as const,
            outcome: existing.outcome as StoredOutcome,
          };
        }

        // Indeterminate is the durable pre-send state. If the process exits
        // after this write, a repeated key observes uncertainty and never
        // automatically calls the provider again.
        tx.insert(originSendAttempts)
          .values({
            appId: input.appId,
            refHash: input.refHash,
            idempotencyKey: input.idempotencyKey,
            payloadHash: input.payloadHash,
            outcome: { status: "indeterminate", deduplicated: false },
            createdAt: input.now,
            updatedAt: input.now,
          })
          .run();
        return { claimed: true as const };
      },
      { behavior: "immediate" },
    );
  }

  finishAttempt(input: {
    appId: string;
    refHash: string;
    idempotencyKey: string;
    outcome: StoredOutcome;
    now: Date;
  }): void {
    this.db
      .update(originSendAttempts)
      .set({ outcome: input.outcome, updatedAt: input.now })
      .where(
        and(
          eq(originSendAttempts.appId, input.appId),
          eq(originSendAttempts.refHash, input.refHash),
          eq(originSendAttempts.idempotencyKey, input.idempotencyKey),
        ),
      )
      .run();
  }

  prune(now: Date): void {
    const routeCutoff = new Date(now.getTime() - ORIGIN_RECORD_RETENTION_MS);
    const attemptCutoff = new Date(now.getTime() - SEND_ATTEMPT_RETENTION_MS);
    this.db.transaction((tx) => {
      tx.delete(originRoutes).where(lt(originRoutes.expiresAt, routeCutoff)).run();
      tx.delete(originSendAttempts).where(lt(originSendAttempts.updatedAt, attemptCutoff)).run();
    });
  }
}

export class OriginMessagingService {
  private readonly repository: OriginMessagingRepository;

  constructor(
    db: DrizzleDb,
    private readonly transport: ExactOriginTransport,
    private readonly isFirstPartyApp: (appId: string) => boolean,
    private readonly now: () => Date = () => new Date(),
  ) {
    this.repository = new OriginMessagingRepository(db);
  }

  async capture(appId: string, route: ExactOriginRoute): Promise<OriginCaptureOutcome> {
    if (!this.isFirstPartyApp(appId)) {
      return { status: "unavailable", reason: "not_authorized" };
    }
    if (!route.connectionId || !route.service || !route.conversationId) {
      return { status: "unavailable", reason: "not_inbound_talk_context" };
    }
    const availability = await this.transport.preflight(route).catch(() => "unavailable" as const);
    if (availability !== "available") {
      return { status: "unavailable", reason: "route_unavailable" };
    }

    const createdAt = this.now();
    this.repository.prune(createdAt);
    const expiresAt = new Date(createdAt.getTime() + ORIGIN_REFERENCE_TTL_MS);
    const reference =
      `${ORIGIN_REFERENCE_PREFIX}${randomBytes(32).toString("base64url")}` as OriginReference;
    this.repository.createRoute({ reference, appId, route, createdAt, expiresAt });
    return { status: "captured", origin: reference, expiresAt: expiresAt.toISOString() };
  }

  async send(
    appId: string,
    input: { origin: string; text: string; idempotencyKey: string },
  ): Promise<OriginSendOutcome> {
    if (!this.isFirstPartyApp(appId)) {
      return { status: "unavailable", deduplicated: false, reason: "origin_unavailable" };
    }
    if (!input.text.trim() || input.text.length > MAX_TEXT_LENGTH) {
      return { status: "invalid_request", deduplicated: false, reason: "invalid_text" };
    }
    if (!input.idempotencyKey.trim() || input.idempotencyKey.length > MAX_IDEMPOTENCY_KEY_LENGTH) {
      return {
        status: "invalid_request",
        deduplicated: false,
        reason: "invalid_idempotency_key",
      };
    }

    if (!ORIGIN_REFERENCE_PATTERN.test(input.origin)) {
      return { status: "unavailable", deduplicated: false, reason: "origin_unavailable" };
    }

    const origin = input.origin as OriginReference;
    const refHash = referenceHash(origin);
    const now = this.now();
    this.repository.prune(now);
    const claim = this.repository.claimAttempt({
      appId,
      refHash,
      idempotencyKey: input.idempotencyKey,
      payloadHash: payloadHash(input.text),
      now,
    });
    if (!claim.claimed) {
      if (claim.conflict) {
        return {
          status: "invalid_request",
          deduplicated: false,
          reason: "idempotency_conflict",
        };
      }
      return publicOutcome(claim.outcome, true);
    }

    let outcome: OriginSendOutcome;
    const route = this.repository.findRoute(origin, appId);
    if (!route) {
      outcome = { status: "unavailable", deduplicated: false, reason: "origin_unavailable" };
    } else if (route.status === "revoked") {
      outcome = { status: "unavailable", deduplicated: false, reason: "origin_unavailable" };
    } else if (route.expiresAt.getTime() <= this.now().getTime()) {
      outcome = { status: "unavailable", deduplicated: false, reason: "origin_unavailable" };
    } else {
      const exactRoute = {
        connectionId: route.connectionId,
        service: route.service,
        conversationId: route.conversationId,
      };
      const availability = await this.transport
        .preflight(exactRoute)
        .catch(() => "unavailable" as const);
      if (availability !== "available") {
        outcome = { status: "unavailable", deduplicated: false, reason: "origin_unavailable" };
      } else {
        try {
          const receipt = await this.transport.send(exactRoute, input.text);
          outcome =
            receipt.conversationId === route.conversationId
              ? {
                  status: "accepted",
                  deduplicated: false,
                  receipt: sanitizeReceipt(receipt),
                }
              : { status: "indeterminate", deduplicated: false };
        } catch {
          // A provider error cannot prove whether the provider accepted the
          // message. Persist uncertainty and leave retries to a new explicit
          // idempotency key rather than risking duplicate delivery.
          outcome = { status: "indeterminate", deduplicated: false };
        }
      }
    }

    this.repository.finishAttempt({
      appId,
      refHash,
      idempotencyKey: input.idempotencyKey,
      outcome,
      now: this.now(),
    });
    return publicOutcome(outcome, false);
  }
}

export const originMessagingInternals = {
  referenceTtlMs: ORIGIN_REFERENCE_TTL_MS,
  routeRetentionMs: ORIGIN_RECORD_RETENTION_MS,
  attemptRetentionMs: SEND_ATTEMPT_RETENTION_MS,
};
