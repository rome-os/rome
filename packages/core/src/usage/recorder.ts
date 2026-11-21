import { randomUUID } from "node:crypto";
import { createLogger } from "../logger.js";
import type { UsageAttributionResolver } from "./attribution.js";
import type { RomeSessionType } from "@rome-os/app-runtime";
import type { SessionKind, TurnUsageFacts } from "../agent/index.js";
import type { LoginMethod, TranscriptionUsageEvent, TurnUsageEvent, UsageEvent } from "./events.js";

/** The chat type a turn counts under when its chat's row is missing, by its
 *  session's kind. A web chat always has its row, so a conversation without
 *  one is a connected account's. */
const FALLBACK_TYPE: Record<SessionKind, RomeSessionType> = {
  conversation: "channel",
  action: "action",
  fork: "fork",
  subagent: "subagent",
};

const log = createLogger("usage-recorder");

/** The seam the turn usage reporter hands each ended turn to. Never throws and never blocks the turn. */
export interface TurnUsageSink {
  recordTurn(facts: TurnUsageFacts): void;
}

/** The sign-in seam the auth routes call. Never throws and never blocks the sign-in. */
export interface LoginUsageSink {
  recordLogin(method: LoginMethod): void;
}

/** The seam voice input hands each ended Rome Cloud listening session to. Never throws. */
export interface TranscriptionUsageSink {
  recordTranscription(
    session: Omit<TranscriptionUsageEvent, "type" | "eventId" | "kind" | "occurredAt">,
  ): void;
}

export interface UsageRecorderDeps {
  outbox: { enqueue(event: UsageEvent, credential: string): Promise<void> };
  attribution: Pick<UsageAttributionResolver, "forTurn">;
  /**
   * Fingerprint of the current instance credential, or null while the
   * instance is not signed in to Rome Cloud.
   */
  credential: () => string | null;
}

/**
 * Turns finished turns and guardian sign-ins into queued usage events. One
 * that happens while the instance is not signed in to Rome Cloud is not
 * recorded.
 */
export class UsageRecorder implements TurnUsageSink, LoginUsageSink, TranscriptionUsageSink {
  private readonly pending = new Set<Promise<void>>();

  constructor(private readonly deps: UsageRecorderDeps) {}

  recordTurn(facts: TurnUsageFacts): void {
    // Bound when the turn ends, so a sign-in that changes before the event is
    // written cannot move it to another enrollment.
    const credential = this.deps.credential();
    if (!credential) return;
    this.track(
      this.writeTurn(facts, credential).catch((err: unknown) => {
        log.warn("failed to queue turn usage", {
          turnId: facts.turnId,
          error: err instanceof Error ? err.message : String(err),
        });
      }),
    );
  }

  recordLogin(method: LoginMethod): void {
    const credential = this.deps.credential();
    if (!credential) return;
    const event: UsageEvent = {
      type: "login",
      eventId: randomUUID(),
      kind: method,
      occurredAt: new Date().toISOString(),
    };
    this.track(
      this.deps.outbox.enqueue(event, credential).catch((err: unknown) => {
        log.warn("failed to queue login usage", {
          method,
          error: err instanceof Error ? err.message : String(err),
        });
      }),
    );
  }

  recordTranscription(
    session: Omit<TranscriptionUsageEvent, "type" | "eventId" | "kind" | "occurredAt">,
  ): void {
    const credential = this.deps.credential();
    if (!credential) return;
    const event: UsageEvent = {
      type: "transcription",
      eventId: session.sessionId,
      kind: "voice_input",
      ...session,
      occurredAt: new Date().toISOString(),
    };
    this.track(
      this.deps.outbox.enqueue(event, credential).catch((err: unknown) => {
        log.warn("failed to queue transcription usage", {
          sessionId: session.sessionId,
          error: err instanceof Error ? err.message : String(err),
        });
      }),
    );
  }

  /** Resolves once every turn recorded so far is queued or has failed. */
  async flush(): Promise<void> {
    await Promise.all(this.pending);
  }

  private track(write: Promise<void>): void {
    this.pending.add(write);
    void write.finally(() => this.pending.delete(write));
  }

  private async writeTurn(facts: TurnUsageFacts, credential: string): Promise<void> {
    const attribution = await this.deps.attribution.forTurn({
      romeSessionId: facts.romeSessionId,
      fallbackType: FALLBACK_TYPE[facts.sessionKind],
      agentName: facts.agentName,
    });
    const { accounting } = facts;
    const usage = accounting?.usage;
    const event: TurnUsageEvent = {
      type: "turn",
      eventId: facts.turnId,
      kind: attribution.kind,
      appId: attribution.appId,
      trigger: attribution.trigger,
      status: facts.status,
      provider: accounting?.provider ?? facts.provider,
      model: accounting?.model ?? facts.model,
      loginKind: facts.loginKind,
      providerTurnId: facts.providerTurnId ?? null,
      inputTokens: tokenCount(usage?.inputTokens),
      outputTokens: tokenCount(usage?.outputTokens),
      cacheReadTokens: tokenCount(usage?.cacheReadTokens),
      cacheWriteTokens: tokenCount(usage?.cacheWriteTokens),
      estimatedCostMicros: costMicros(accounting?.costUsd),
      durationMs: facts.durationMs === undefined ? null : Math.max(0, Math.round(facts.durationMs)),
      occurredAt: facts.finishedAt.toISOString(),
    };
    await this.deps.outbox.enqueue(event, credential);
  }
}

function tokenCount(value: number | undefined): number {
  return value !== undefined && Number.isFinite(value) ? Math.max(0, Math.round(value)) : 0;
}

function costMicros(costUsd: number | undefined): string | null {
  if (costUsd === undefined || !Number.isFinite(costUsd) || costUsd < 0) return null;
  return String(Math.round(costUsd * 1_000_000));
}
