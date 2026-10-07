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

/** How long a publisher's claim on an event holds. It outlasts the longest
 * publish, since core queues an app's `runAction` for up to ten minutes when
 * every action worker is busy. A claim older than this belongs to a publisher
 * that died, and the event is owed a publish again. */
export const PUBLISH_CLAIM_LEASE_MS = 15 * 60_000;

/** Publish attempts before the outbox gives up on an event, so one event that
 * always fails cannot hold the head of the line forever. */
export const MAX_PUBLISH_ATTEMPTS = 5;

/** An event claimed for publishing, with the attempt count including this one. */
export interface ClaimedEvent {
  eventId: string;
  topic: string;
  provider: string;
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

  async pruneRingBuffer(cap: number = EMITTED_EVENTS_RING_CAP): Promise<void> {
    await this.db.connection.run(sql`
      DELETE FROM ${emittedEvents}
      WHERE ${emittedEvents.eventId} IN (
        SELECT ${emittedEvents.eventId} FROM ${emittedEvents}
        ORDER BY ${emittedEvents.receivedAt} DESC
        LIMIT -1 OFFSET ${cap}
      )
    `);
  }

  /**
   * Claims the oldest event still owed a publish and counts the attempt.
   * Returns null when no event is owed one. Two concurrent callers never claim
   * the same event, because SQLite runs each UPDATE alone.
   */
  async claimNextUnpublished(now: Date): Promise<ClaimedEvent | null> {
    const leaseCutoff = new Date(now.getTime() - PUBLISH_CLAIM_LEASE_MS);
    const owed = and(
      isNull(emittedEvents.publishedAt),
      lt(emittedEvents.publishAttempts, MAX_PUBLISH_ATTEMPTS),
      or(isNull(emittedEvents.publishClaimedAt), lte(emittedEvents.publishClaimedAt, leaseCutoff)),
    );
    const oldest = this.db.connection
      .select({ eventId: emittedEvents.eventId })
      .from(emittedEvents)
      .where(owed)
      .orderBy(asc(emittedEvents.receivedAt))
      .limit(1);
    const [claimed] = await this.db.connection
      .update(emittedEvents)
      .set({
        publishClaimedAt: now,
        publishAttempts: sql`${emittedEvents.publishAttempts} + 1`,
      })
      .where(and(inArray(emittedEvents.eventId, oldest), owed))
      .returning({
        eventId: emittedEvents.eventId,
        topic: emittedEvents.topic,
        provider: emittedEvents.provider,
        payloadJson: emittedEvents.payloadJson,
        publishAttempts: emittedEvents.publishAttempts,
      });
    return claimed ?? null;
  }

  async markPublished(eventId: string, at: Date): Promise<void> {
    await this.db.connection
      .update(emittedEvents)
      .set({ publishedAt: at, publishClaimedAt: null })
      .where(eq(emittedEvents.eventId, eventId));
  }

  /** Drops a claim after a failed publish, so the next drain retries at once. */
  async releaseClaim(eventId: string): Promise<void> {
    await this.db.connection
      .update(emittedEvents)
      .set({ publishClaimedAt: null })
      .where(eq(emittedEvents.eventId, eventId));
  }

  async listEvents(opts: { topic?: string; limit: number }): Promise<EmittedEventRow[]> {
    const baseQuery = this.db.connection.select().from(emittedEvents);
    const filtered = opts.topic ? baseQuery.where(eq(emittedEvents.topic, opts.topic)) : baseQuery;
    return filtered.orderBy(desc(emittedEvents.receivedAt)).limit(opts.limit);
  }
}
