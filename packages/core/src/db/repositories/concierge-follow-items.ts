import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, gte, inArray, isNotNull, isNull, lt, or } from "drizzle-orm";
import type { DrizzleDb } from "../index.js";
import { conciergeFollowItems } from "../schema.js";

export type ConciergeFollowItemRow = typeof conciergeFollowItems.$inferSelect;
export type FollowItemDecision = ConciergeFollowItemRow["decision"];

export interface FollowItemInput {
  eventId: string;
  source: string;
  kind: string;
  target: string;
  decision: FollowItemDecision;
  reason: string;
  line: string;
  url?: string | null;
}

/**
 * The events the Concierge's triage kept, each owed until the guardian was
 * told: `important` ones go to the Concierge after their batch, and `digest`
 * ones, with the important ones it did not tell, at the next digest.
 */
export class ConciergeFollowItemsRepository {
  constructor(private db: DrizzleDb) {}

  /** Stores the items; an event already stored is kept as it was. Answers the stored ones. */
  async add(items: FollowItemInput[], at: Date): Promise<ConciergeFollowItemRow[]> {
    if (items.length === 0) return [];
    return this.db
      .insert(conciergeFollowItems)
      .values(
        items.map((item) => ({
          id: randomUUID(),
          eventId: item.eventId,
          source: item.source,
          kind: item.kind,
          target: item.target,
          decision: item.decision,
          reason: item.reason,
          line: item.line,
          url: item.url ?? null,
          createdAt: at,
        })),
      )
      .onConflictDoNothing({ target: conciergeFollowItems.eventId })
      .returning();
  }

  /** The event ids among `eventIds` that are already stored. */
  async known(eventIds: string[]): Promise<Set<string>> {
    if (eventIds.length === 0) return new Set();
    const rows = await this.db
      .select({ eventId: conciergeFollowItems.eventId })
      .from(conciergeFollowItems)
      .where(inArray(conciergeFollowItems.eventId, eventIds));
    return new Set(rows.map((row) => row.eventId));
  }

  /**
   * What is owed, oldest first. `important`: important items the Concierge has
   * not had yet. `digest`: digest items, and important items left for the
   * digest, which keep their decision so the digest can rank them first.
   */
  async owed(to: FollowItemDecision): Promise<ConciergeFollowItemRow[]> {
    const items = conciergeFollowItems;
    return this.db
      .select()
      .from(items)
      .where(
        and(
          isNull(items.deliveredAt),
          to === "important"
            ? and(eq(items.decision, "important"), isNull(items.deferredAt))
            : or(eq(items.decision, "digest"), isNotNull(items.deferredAt)),
        ),
      )
      .orderBy(asc(items.createdAt));
  }

  async markDelivered(ids: string[], at: Date): Promise<void> {
    if (ids.length === 0) return;
    await this.db
      .update(conciergeFollowItems)
      .set({ deliveredAt: at })
      .where(inArray(conciergeFollowItems.id, ids));
  }

  /** Leaves owed important items for the digest. They stay important. */
  async deferToDigest(ids: string[], at: Date): Promise<void> {
    if (ids.length === 0) return;
    await this.db
      .update(conciergeFollowItems)
      .set({ deferredAt: at })
      .where(and(inArray(conciergeFollowItems.id, ids), isNull(conciergeFollowItems.deliveredAt)));
  }

  /**
   * Important items the Concierge told the guardian since `since`, newest
   * first, so triage knows what was already told. One left for the digest is
   * not among them.
   */
  async recentImportant(since: Date, limit: number): Promise<ConciergeFollowItemRow[]> {
    return this.db
      .select()
      .from(conciergeFollowItems)
      .where(
        and(
          eq(conciergeFollowItems.decision, "important"),
          isNotNull(conciergeFollowItems.deliveredAt),
          isNull(conciergeFollowItems.deferredAt),
          gte(conciergeFollowItems.createdAt, since),
        ),
      )
      .orderBy(desc(conciergeFollowItems.createdAt))
      .limit(limit);
  }

  /** Deletes delivered items older than `before`. */
  async prune(before: Date): Promise<void> {
    await this.db
      .delete(conciergeFollowItems)
      .where(
        and(
          isNotNull(conciergeFollowItems.deliveredAt),
          lt(conciergeFollowItems.deliveredAt, before),
        ),
      );
  }
}
