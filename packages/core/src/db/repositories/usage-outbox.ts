import { asc, eq, inArray, lt, ne } from "drizzle-orm";
import { usageOutbox } from "../schema.js";
import type { DrizzleDb } from "../index.js";
import type { UsageEvent } from "../../usage/events.js";

export interface QueuedUsageEvent {
  seq: number;
  event: UsageEvent;
}

export class UsageOutboxRepository {
  constructor(private db: DrizzleDb) {}

  /**
   * Queues an event under the fingerprint of the instance credential it was
   * recorded under. An event with the same type and id already queued wins.
   */
  async enqueue(event: UsageEvent, credential: string, now = new Date()): Promise<void> {
    await this.db
      .insert(usageOutbox)
      .values({
        type: event.type,
        eventId: event.eventId,
        payload: event,
        credential,
        createdAt: now,
      })
      .onConflictDoNothing();
  }

  /** The oldest events queued under `credential`, in enqueue order. Does not remove them. */
  async peek(credential: string, limit: number): Promise<QueuedUsageEvent[]> {
    const rows = await this.db
      .select({ seq: usageOutbox.seq, payload: usageOutbox.payload })
      .from(usageOutbox)
      .where(eq(usageOutbox.credential, credential))
      .orderBy(asc(usageOutbox.seq))
      .limit(limit);
    return rows.map((row) => ({ seq: row.seq, event: row.payload }));
  }

  async remove(seqs: number[]): Promise<void> {
    if (seqs.length === 0) return;
    await this.db.delete(usageOutbox).where(inArray(usageOutbox.seq, seqs));
  }

  /** Drops events queued under any other credential. Returns how many were dropped. */
  async pruneOtherCredentials(credential: string): Promise<number> {
    const removed = await this.db
      .delete(usageOutbox)
      .where(ne(usageOutbox.credential, credential))
      .returning({ seq: usageOutbox.seq });
    return removed.length;
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
