import { asc, inArray, lt } from "drizzle-orm";
import { usageOutbox } from "../schema.js";
import type { DrizzleDb } from "../index.js";
import type { UsageEvent } from "../../usage/events.js";

export interface QueuedUsageEvent {
  seq: number;
  event: UsageEvent;
}

export class UsageOutboxRepository {
  constructor(private db: DrizzleDb) {}

  /** Queues an event. An event with the same type and id already queued wins. */
  async enqueue(event: UsageEvent, now = new Date()): Promise<void> {
    await this.db
      .insert(usageOutbox)
      .values({ type: event.type, eventId: event.eventId, payload: event, createdAt: now })
      .onConflictDoNothing();
  }

  /** The oldest queued events, in enqueue order. Does not remove them. */
  async peek(limit: number): Promise<QueuedUsageEvent[]> {
    const rows = await this.db
      .select({ seq: usageOutbox.seq, payload: usageOutbox.payload })
      .from(usageOutbox)
      .orderBy(asc(usageOutbox.seq))
      .limit(limit);
    return rows.map((row) => ({ seq: row.seq, event: row.payload }));
  }

  async remove(seqs: number[]): Promise<void> {
    if (seqs.length === 0) return;
    await this.db.delete(usageOutbox).where(inArray(usageOutbox.seq, seqs));
  }

  /** Drops events queued before `cutoff`. Returns how many were dropped. */
  async pruneBefore(cutoff: Date): Promise<number> {
    const removed = await this.db
      .delete(usageOutbox)
      .where(lt(usageOutbox.createdAt, cutoff))
      .returning({ seq: usageOutbox.seq });
    return removed.length;
  }
}
