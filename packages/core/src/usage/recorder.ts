import { randomUUID } from "node:crypto";
import type { AgentAccounting, AgentTurnStatus, RomeSessionType } from "@rome-os/app-runtime";
import { createLogger } from "../logger.js";
import type { UsageAttributionResolver } from "./attribution.js";
import type { LoginMethod, TurnUsageEvent, UsageEvent, UsageFunding } from "./events.js";

const log = createLogger("usage-recorder");

/** What AgentSession knows about a turn when it ends. */
export interface TurnUsageFacts {
  turnId: string;
  romeSessionId: string;
  romeSessionType: RomeSessionType;
  agentName: string;
  status: AgentTurnStatus;
  /** The model session that served the turn. Accounting, when present, wins. */
  provider: string;
  model: string;
  funding: UsageFunding | undefined;
  providerTurnId: string | undefined;
  accounting: AgentAccounting | undefined;
  durationMs: number | undefined;
  finishedAt: Date;
}

/** The turn-end seam AgentSession calls. Never throws and never blocks the turn. */
export interface TurnUsageSink {
  recordTurn(facts: TurnUsageFacts): void;
}

/** The sign-in seam the auth routes call. Never throws and never blocks the sign-in. */
export interface LoginUsageSink {
  recordLogin(method: LoginMethod): void;
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
export class UsageRecorder implements TurnUsageSink, LoginUsageSink {
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
      fallbackType: facts.romeSessionType,
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
      funding: facts.funding ?? "unknown",
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
