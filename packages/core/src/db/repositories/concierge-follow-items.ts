import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, gte, inArray, isNull, lt, isNotNull } from "drizzle-orm";
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
 * The events the Concierge's triage kept, each owed to the Concierge until
 * delivered: `notify` ones in the next batch, `digest` ones at the next digest.
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

  /** The items of a decision not yet delivered, oldest first. */
  async owed(decision: FollowItemDecision): Promise<ConciergeFollowItemRow[]> {
    return this.db
      .select()
      .from(conciergeFollowItems)
      .where(
        and(eq(conciergeFollowItems.decision, decision), isNull(conciergeFollowItems.deliveredAt)),
      )
      .orderBy(asc(conciergeFollowItems.createdAt));
  }

  async markDelivered(ids: string[], at: Date): Promise<void> {
    if (ids.length === 0) return;
    await this.db
      .update(conciergeFollowItems)
      .set({ deliveredAt: at })
      .where(inArray(conciergeFollowItems.id, ids));
  }

  /** Moves owed notify items to the digest. */
  async moveToDigest(ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    await this.db
      .update(conciergeFollowItems)
      .set({ decision: "digest" })
      .where(and(inArray(conciergeFollowItems.id, ids), isNull(conciergeFollowItems.deliveredAt)));
  }

  /** Notify items since `since`, newest first, so triage knows what was already told. */
  async recentNotify(since: Date, limit: number): Promise<ConciergeFollowItemRow[]> {
    return this.db
      .select()
      .from(conciergeFollowItems)
      .where(
        and(
          eq(conciergeFollowItems.decision, "notify"),
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
