import { and, asc, desc, eq, inArray, isNull, lt, lte, or, sql } from "drizzle-orm";
import type { AppDbContext } from "@rome-os/app-runtime";
import { emittedEvents } from "../db/schema.js";

export interface EmittedEventRow {
  eventId: string;
  topic: string;
  provider: string;
  eventType: string;
  receivedAt: Date;
  payloadJson: string;
}

export const EMITTED_EVENTS_RING_CAP = 500;

/** How long a publisher's claim on an event holds. It outlasts any single
 * publish, including a wait for a free action worker. A claim older than this
 * belongs to a publisher that died, and the event is owed a publish again. */
export const PUBLISH_CLAIM_LEASE_MS = 15 * 60_000;

/** Failed publishes before the outbox gives up on an event, so one event that
 * always fails cannot hold the head of the line forever. */
export const MAX_PUBLISH_ATTEMPTS = 5;

/** Wait before retrying after the nth failed publish: 1, 4, 16, then 64
 * minutes. Spaced so a burst of busy action workers cannot use up an event's
 * attempts within seconds. */
export function publishRetryDelayMs(failures: number): number {
  return 60_000 * 4 ** (failures - 1);
}

/** An event claimed for publishing. `publishAttempts` counts earlier failures. */
export interface ClaimedEvent {
  eventId: string;
  topic: string;
  provider: string;
  receivedAt: Date;
  payloadJson: string;
  publishAttempts: number;
}

export class EventsRepo {
  constructor(private readonly db: AppDbContext) {}

  /**
   * Returns true when the event was inserted; false when it was a no-op
   * (Composio retry with the same eventId).
   */
  async insertEventIfAbsent(row: EmittedEventRow): Promise<boolean> {
    const result = await this.db.connection
      .insert(emittedEvents)
      .values(row)
      .onConflictDoNothing({ target: emittedEvents.eventId });
    return result.changes > 0;
  }

  /** Deletes events beyond the newest `cap`, except those still owed a publish.
   * The outbox is the only record of an owed event, so the ring never drops one. */
  async pruneRingBuffer(cap: number = EMITTED_EVENTS_RING_CAP): Promise<void> {
    await this.db.connection.run(sql`
      DELETE FROM ${emittedEvents}
      WHERE ${emittedEvents.eventId} IN (
        SELECT ${emittedEvents.eventId} FROM ${emittedEvents}
        ORDER BY ${emittedEvents.receivedAt} DESC
        LIMIT -1 OFFSET ${cap}
      )
      AND (${emittedEvents.publishedAt} IS NOT NULL
        OR ${emittedEvents.publishAttempts} >= ${MAX_PUBLISH_ATTEMPTS})
    `);
  }

  /**
   * Claims the oldest event that is owed a publish and due for an attempt, and
   * holds it for PUBLISH_CLAIM_LEASE_MS. Returns null when none is due. Two
   * concurrent callers never claim the same event, because SQLite runs each
   * UPDATE alone.
   */
  async claimNextUnpublished(now: Date): Promise<ClaimedEvent | null> {
    const due = and(
      isNull(emittedEvents.publishedAt),
      lt(emittedEvents.publishAttempts, MAX_PUBLISH_ATTEMPTS),
      or(isNull(emittedEvents.nextAttemptAt), lte(emittedEvents.nextAttemptAt, now)),
    );
    const oldest = this.db.connection
      .select({ eventId: emittedEvents.eventId })
      .from(emittedEvents)
      .where(due)
      .orderBy(asc(emittedEvents.receivedAt))
      .limit(1);
    const [claimed] = await this.db.connection
      .update(emittedEvents)
      .set({ nextAttemptAt: new Date(now.getTime() + PUBLISH_CLAIM_LEASE_MS) })
      .where(and(inArray(emittedEvents.eventId, oldest), due))
      .returning({
        eventId: emittedEvents.eventId,
        topic: emittedEvents.topic,
        provider: emittedEvents.provider,
        receivedAt: emittedEvents.receivedAt,
        payloadJson: emittedEvents.payloadJson,
        publishAttempts: emittedEvents.publishAttempts,
      });
    return claimed ?? null;
  }

  async markPublished(eventId: string, at: Date): Promise<void> {
    await this.db.connection
      .update(emittedEvents)
      .set({ publishedAt: at, nextAttemptAt: null })
      .where(eq(emittedEvents.eventId, eventId));
  }

  /** Records a failed publish. The event is due again at `retryAt`. */
  async recordFailedPublish(eventId: string, failures: number, retryAt: Date): Promise<void> {
    await this.db.connection
      .update(emittedEvents)
      .set({ publishAttempts: failures, nextAttemptAt: retryAt })
      .where(eq(emittedEvents.eventId, eventId));
  }

  /** Stops publishing an event. It stays listed, and the ring may prune it. */
  async abandon(eventId: string): Promise<void> {
    await this.db.connection
      .update(emittedEvents)
      .set({ publishAttempts: MAX_PUBLISH_ATTEMPTS, nextAttemptAt: null })
      .where(eq(emittedEvents.eventId, eventId));
  }

  async listEvents(opts: { topic?: string; limit: number }): Promise<EmittedEventRow[]> {
    const baseQuery = this.db.connection.select().from(emittedEvents);
    const filtered = opts.topic ? baseQuery.where(eq(emittedEvents.topic, opts.topic)) : baseQuery;
    return filtered.orderBy(desc(emittedEvents.receivedAt)).limit(opts.limit);
  }
}
