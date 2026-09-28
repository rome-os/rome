import { eq } from "drizzle-orm";
import type { DrizzleDb } from "../index.js";
import { replyDeliveryParts } from "../schema.js";
import type { DeliveryAttempt, DeliveryRepository } from "../../connections/delivery/transport.js";

export class ReplyDeliveryRepository implements DeliveryRepository {
  constructor(private readonly db: DrizzleDb) {}

  async record(attempt: DeliveryAttempt): Promise<void> {
    const row = { ...attempt, updatedAt: new Date() };
    await this.db
      .insert(replyDeliveryParts)
      .values(row)
      .onConflictDoUpdate({
        target: [replyDeliveryParts.runId, replyDeliveryParts.blockIx, replyDeliveryParts.partIx],
        set: row,
      });
  }

  async recoverInterrupted(): Promise<void> {
    await this.db
      .update(replyDeliveryParts)
      .set({ outcome: "unknown", updatedAt: new Date() })
      .where(eq(replyDeliveryParts.outcome, "attempting"));
  }
}
