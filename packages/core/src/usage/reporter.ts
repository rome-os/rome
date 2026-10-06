// Ships queued usage events to Rome Cloud and queues finished action runs.
// Contract: docs/concepts/rome-cloud.md#usage-reporting.

import type { ActionExecutionsRepository } from "../db/repositories/action-executions.js";
import type { SettingsRepository } from "../db/repositories/settings.js";
import type { UsageOutboxRepository } from "../db/repositories/usage-outbox.js";
import { createLogger } from "../logger.js";
import type { UsageAttributionResolver } from "./attribution.js";
import type { ActionRunUsageEvent } from "./events.js";

const log = createLogger("usage-reporter");

export const ACTION_RUN_CURSOR_KEY = "usageReporting.actionRunCursor";
const DEFAULT_INTERVAL_MS = 60_000;
const BATCH_SIZE = 200;
const MAX_BATCHES_PER_TICK = 10;
const SWEEP_PAGE_SIZE = 500;
const MAX_SWEEP_PAGES_PER_TICK = 10;
// A root execution's finish time is taken just before its row is written, so
// a run that finished slightly earlier can commit after a later one. Sweeping
// only runs older than this keeps the cursor from passing an uncommitted row.
const SWEEP_LAG_MS = 10_000;
// Queued events older than this are dropped, so an instance that stays signed
// out of Rome Cloud does not grow the outbox without bound.
const OUTBOX_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 15_000;

interface ActionRunCursor {
  finishedAt: string;
  id: string;
}

export interface RomeCloudAccess {
  token: string;
  origin: string;
}

export interface UsageReporterDeps {
  outbox: Pick<UsageOutboxRepository, "enqueue" | "peek" | "remove" | "pruneBefore">;
  executions: Pick<ActionExecutionsRepository, "findFinishedTopLevelAfter">;
  settings: Pick<SettingsRepository, "get" | "set">;
  attribution: Pick<UsageAttributionResolver, "forActionRun">;
  /** The instance credential and Rome Cloud origin, or null when not signed in. */
  access: () => RomeCloudAccess | null;
  fetch?: typeof fetch;
  intervalMs?: number;
  now?: () => Date;
}

type ShipOutcome = "delivered" | "dropped" | "retry_later";

export class UsageReporter {
  private timer: ReturnType<typeof setInterval> | null = null;
  private inFlight: Promise<void> | null = null;

  constructor(private readonly deps: UsageReporterDeps) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), this.deps.intervalMs ?? DEFAULT_INTERVAL_MS);
    this.timer.unref?.();
  }

  /** Stops the timer and waits for a tick in progress. */
  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.inFlight;
  }

  /** One sweep-and-ship pass. A call while a pass runs joins that pass. */
  async tick(): Promise<void> {
    this.inFlight ??= this.runTick().finally(() => {
      this.inFlight = null;
    });
    await this.inFlight;
  }

  private async runTick(): Promise<void> {
    try {
      await this.sweepActionRuns();
      const dropped = await this.deps.outbox.pruneBefore(
        new Date(this.now().getTime() - OUTBOX_RETENTION_MS),
      );
      if (dropped > 0) log.warn("dropped undelivered usage events past retention", { dropped });
      await this.ship();
    } catch (err) {
      log.warn("usage report pass failed", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // The cursor advances whether or not the instance is signed in, so signing
  // in later does not report runs from the signed-out period.
  private async sweepActionRuns(): Promise<void> {
    const until = new Date(this.now().getTime() - SWEEP_LAG_MS);
    const stored = await this.deps.settings.get<ActionRunCursor>(ACTION_RUN_CURSOR_KEY);
    if (!stored) {
      await this.deps.settings.set(ACTION_RUN_CURSOR_KEY, {
        finishedAt: until.toISOString(),
        id: "",
      } satisfies ActionRunCursor);
      return;
    }
    let after = { finishedAt: new Date(stored.finishedAt), id: stored.id };
    const reporting = this.deps.access() !== null;
    for (let page = 0; page < MAX_SWEEP_PAGES_PER_TICK; page++) {
      const rows = await this.deps.executions.findFinishedTopLevelAfter({
        after,
        until,
        limit: SWEEP_PAGE_SIZE,
      });
      for (const row of rows) {
        const attribution = reporting ? this.deps.attribution.forActionRun(row) : null;
        if (attribution && row.finishedAt) {
          const event: ActionRunUsageEvent = {
            type: "action_run",
            eventId: row.id,
            kind: attribution.kind,
            appId: attribution.appId,
            status: row.status as ActionRunUsageEvent["status"],
            durationMs: row.durationMs ?? null,
            occurredAt: row.finishedAt.toISOString(),
          };
          await this.deps.outbox.enqueue(event);
        }
      }
      const last = rows.at(-1);
      if (last?.finishedAt) {
        after = { finishedAt: last.finishedAt, id: last.id };
        await this.deps.settings.set(ACTION_RUN_CURSOR_KEY, {
          finishedAt: last.finishedAt.toISOString(),
          id: last.id,
        } satisfies ActionRunCursor);
      }
      if (rows.length < SWEEP_PAGE_SIZE) return;
    }
  }

  private async ship(): Promise<void> {
    for (let batch = 0; batch < MAX_BATCHES_PER_TICK; batch++) {
      const access = this.deps.access();
      if (!access) return;
      const queued = await this.deps.outbox.peek(BATCH_SIZE);
      if (queued.length === 0) return;
      const outcome = await this.post(
        access,
        queued.map((entry) => entry.event),
      );
      if (outcome === "retry_later") return;
      await this.deps.outbox.remove(queued.map((entry) => entry.seq));
      if (queued.length < BATCH_SIZE) return;
    }
  }

  private async post(access: RomeCloudAccess, events: unknown[]): Promise<ShipOutcome> {
    let response: Response;
    try {
      response = await (this.deps.fetch ?? globalThis.fetch)(
        new URL("/v1/usage/events", access.origin),
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${access.token}`,
            "Content-Type": "application/json",
            "Cache-Control": "no-store",
          },
          body: JSON.stringify({ events }),
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        },
      );
    } catch (err) {
      log.info("usage report deferred: Rome Cloud unreachable", {
        error: err instanceof Error ? err.message : String(err),
      });
      return "retry_later";
    }
    if (response.ok) {
      const body = (await response.json().catch(() => null)) as {
        rejected?: Array<{ eventId: string | null; error: string }>;
      } | null;
      const rejected = body?.rejected ?? [];
      if (rejected.length > 0) {
        log.warn("Rome Cloud rejected usage events", {
          count: rejected.length,
          first: rejected[0],
        });
      }
      return "delivered";
    }
    await response.body?.cancel().catch(() => {});
    // Signed out or revoked, rate limited, timed out, or a server fault: the
    // events stay queued. Any other client error means this batch can never be
    // accepted, so it is dropped rather than retried forever.
    if (
      response.status === 401 ||
      response.status === 403 ||
      response.status === 408 ||
      response.status === 429 ||
      response.status >= 500
    ) {
      return "retry_later";
    }
    log.error("Rome Cloud refused a usage batch; dropping it", {
      status: response.status,
      events: events.length,
    });
    return "dropped";
  }

  private now(): Date {
    return this.deps.now?.() ?? new Date();
  }
}
