import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, gte, inArray, isNotNull, isNull, lt } from "drizzle-orm";
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
  /** The Concierge chat its follow reports to. Null or absent is the guardian's main chat. */
  chatId?: string | null;
  /** Whose follow kept it. Absent is the guardian. */
  ownerKey?: string;
}

/**
 * The events the Concierge's triage kept. An `important` one is owed to the
 * Concierge after its batch, and every one is owed to the next digest, whether
 * the Concierge told the guardian of it or not.
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
          chatId: item.chatId ?? null,
          ownerKey: item.ownerKey ?? "guardian",
          createdAt: at,
        })),
      )
      .onConflictDoNothing({
        target: [conciergeFollowItems.ownerKey, conciergeFollowItems.eventId],
      })
      .returning();
  }

  /** The event ids among `eventIds` that are already stored for `owner`. */
  async known(eventIds: string[], owner = "guardian"): Promise<Set<string>> {
    if (eventIds.length === 0) return new Set();
    const rows = await this.db
      .select({ eventId: conciergeFollowItems.eventId })
      .from(conciergeFollowItems)
      .where(
        and(
          eq(conciergeFollowItems.ownerKey, owner),
          inArray(conciergeFollowItems.eventId, eventIds),
        ),
      );
    return new Set(rows.map((row) => row.eventId));
  }

  /** Important items the Concierge has not had yet, oldest first. */
  async owedToConcierge(): Promise<ConciergeFollowItemRow[]> {
    return this.db
      .select()
      .from(conciergeFollowItems)
      .where(
        and(eq(conciergeFollowItems.decision, "important"), isNull(conciergeFollowItems.offeredAt)),
      )
      .orderBy(asc(conciergeFollowItems.createdAt));
  }

  /** Every item of `owner` no digest has included yet, important or not, oldest first. */
  async owedToDigest(owner = "guardian"): Promise<ConciergeFollowItemRow[]> {
    return this.db
      .select()
      .from(conciergeFollowItems)
      .where(and(isNull(conciergeFollowItems.digestedAt), eq(conciergeFollowItems.ownerKey, owner)))
      .orderBy(asc(conciergeFollowItems.createdAt));
  }

  /** Moves the items of Concierge chat `from` to its owner's main chat `to` (null for the guardian's). */
  async moveToMainChat(from: string, to: string | null = null): Promise<void> {
    await this.db
      .update(conciergeFollowItems)
      .set({ chatId: to })
      .where(eq(conciergeFollowItems.chatId, from));
  }

  /** Important items that went to the Concierge, or that the hourly cap skipped. */
  async markOffered(ids: string[], at: Date): Promise<void> {
    if (ids.length === 0) return;
    await this.db
      .update(conciergeFollowItems)
      .set({ offeredAt: at })
      .where(inArray(conciergeFollowItems.id, ids));
  }

  /** Items a digest included. */
  async markDigested(ids: string[], at: Date): Promise<void> {
    if (ids.length === 0) return;
    await this.db
      .update(conciergeFollowItems)
      .set({ digestedAt: at })
      .where(inArray(conciergeFollowItems.id, ids));
  }

  /**
   * Important items the Concierge had since `since`, newest first, so triage
   * knows what was already raised.
   */
  async recentImportant(
    since: Date,
    limit: number,
    owner = "guardian",
  ): Promise<ConciergeFollowItemRow[]> {
    return this.db
      .select()
      .from(conciergeFollowItems)
      .where(
        and(
          eq(conciergeFollowItems.ownerKey, owner),
          eq(conciergeFollowItems.decision, "important"),
          isNotNull(conciergeFollowItems.offeredAt),
          gte(conciergeFollowItems.createdAt, since),
        ),
      )
      .orderBy(desc(conciergeFollowItems.createdAt))
      .limit(limit);
  }

  /** Deletes digested items older than `before`. */
  async prune(before: Date): Promise<void> {
    await this.db
      .delete(conciergeFollowItems)
      .where(
        and(
          isNotNull(conciergeFollowItems.digestedAt),
          lt(conciergeFollowItems.digestedAt, before),
        ),
      );
  }
}
