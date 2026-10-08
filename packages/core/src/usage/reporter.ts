// Ships queued usage events to Rome Cloud and queues finished action runs.
// Contract: docs/concepts/rome-cloud.md#usage-reporting.

import { createHash } from "node:crypto";
import type { ActionExecutionsRepository } from "../db/repositories/action-executions.js";
import type { SettingsRepository } from "../db/repositories/settings.js";
import type { UsageOutboxRepository } from "../db/repositories/usage-outbox.js";
import type { SessionActor } from "../lib/session-actor.js";
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

/**
 * Names the enrollment usage belongs to without storing the token. Signing in
 * again mints a new credential, which Rome Cloud treats as a new instance.
 */
export function credentialFingerprint(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

interface ActionRunCursor {
  finishedAt: string;
  id: string;
  /**
   * Fingerprint of the instance credential the sweep that wrote this cursor
   * ran under, or null when it ran signed out.
   */
  credential?: string | null;
}

export interface RomeCloudAccess {
  token: string;
  origin: string;
}

export interface UsageReporterDeps {
  outbox: Pick<
    UsageOutboxRepository,
    "enqueue" | "peek" | "remove" | "pruneBefore" | "pruneOtherCredentials"
  >;
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
    // The first pass starts the action-run cursor, so runs that finish before
    // the first interval are not mistaken for history.
    void this.tick();
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

  // A run is reported only if the sweeps on both sides of it ran under the
  // same instance credential. The first sweep, a signed-out sweep, and the
  // first sweep under a new credential move the cursor to now without
  // reporting, because a run in the lag window or between sweeps may have
  // finished while signed out.
  private async sweepActionRuns(): Promise<void> {
    const now = this.now();
    const stored = await this.deps.settings.get<ActionRunCursor>(ACTION_RUN_CURSOR_KEY);
    const access = this.deps.access();
    const credential = access ? credentialFingerprint(access.token) : null;
    if (!stored || !credential || stored.credential !== credential) {
      // finished_at is stored in whole seconds, so a cursor inside a second
      // would still admit that second's earlier runs. Start at the next one.
      const nextSecond = new Date((Math.floor(now.getTime() / 1000) + 1) * 1000);
      await this.deps.settings.set(ACTION_RUN_CURSOR_KEY, {
        finishedAt: nextSecond.toISOString(),
        id: "",
        credential,
      } satisfies ActionRunCursor);
      return;
    }
    const until = new Date(now.getTime() - SWEEP_LAG_MS);
    let after = { finishedAt: new Date(stored.finishedAt), id: stored.id };
    for (let page = 0; page < MAX_SWEEP_PAGES_PER_TICK; page++) {
      const rows = await this.deps.executions.findFinishedTopLevelAfter({
        after,
        until,
        limit: SWEEP_PAGE_SIZE,
      });
      for (const row of rows) {
        const attribution = await this.deps.attribution.forActionRun({
          ...row,
          actor: (row.actor ?? null) as SessionActor | null,
        });
        if (attribution && row.finishedAt) {
          const event: ActionRunUsageEvent = {
            type: "action_run",
            eventId: row.id,
            kind: attribution.kind,
            appId: attribution.appId,
            trigger: attribution.trigger,
            status: row.status as ActionRunUsageEvent["status"],
            durationMs: row.durationMs ?? null,
            occurredAt: row.finishedAt.toISOString(),
          };
          await this.deps.outbox.enqueue(event, credential);
        }
      }
      const last = rows.at(-1);
      if (last?.finishedAt) {
        after = { finishedAt: last.finishedAt, id: last.id };
        await this.deps.settings.set(ACTION_RUN_CURSOR_KEY, {
          finishedAt: last.finishedAt.toISOString(),
          id: last.id,
          credential,
        } satisfies ActionRunCursor);
      }
      if (rows.length < SWEEP_PAGE_SIZE) return;
    }
  }

  // Each batch carries only events recorded under the credential that sends
  // it. Events from an earlier enrollment belong to an instance this one no
  // longer is, so they are dropped rather than reported as the new one's.
  private async ship(): Promise<void> {
    for (let batch = 0; batch < MAX_BATCHES_PER_TICK; batch++) {
      const access = this.deps.access();
      if (!access) return;
      const credential = credentialFingerprint(access.token);
      const dropped = await this.deps.outbox.pruneOtherCredentials(credential);
      if (dropped > 0) {
        log.info("dropped usage events queued under an earlier enrollment", { dropped });
      }
      const queued = await this.deps.outbox.peek(credential, BATCH_SIZE);
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
    // Signed out or revoked, a Rome Cloud without the route yet, rate limited,
    // timed out, or a server fault: the events stay queued. Any other client
    // error means this batch can never be accepted, so it is dropped rather
    // than retried forever.
    if (
      response.status === 401 ||
      response.status === 403 ||
      response.status === 404 ||
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
