import { eq, inArray, sql } from "drizzle-orm";
import { v4 as uuid } from "uuid";
import { sentinelLog } from "../schema.js";
import type { DrizzleDb } from "../index.js";

/** One sender the triage record has seen, as the account reads name them. */
export interface SentinelSender {
  channel: string;
  channelUserId: string;
}

export class SentinelLogRepository {
  constructor(private db: DrizzleDb) {}

  async create(data: {
    messageId: string;
    channel: string;
    channelUserId: string;
    displayName?: string;
    threadId?: string;
    text?: string;
    action: "replied" | "ignored" | "escalated";
    response?: string;
  }) {
    const id = uuid();
    const now = new Date();
    await this.db.insert(sentinelLog).values({
      id,
      messageId: data.messageId,
      channel: data.channel,
      channelUserId: data.channelUserId,
      displayName: data.displayName ?? null,
      threadId: data.threadId ?? null,
      text: data.text ?? null,
      action: data.action,
      response: data.response ?? null,
      reviewed: false,
      createdAt: now,
    });
    return id;
  }

  async findUnreviewed() {
    return this.db.select().from(sentinelLog).where(eq(sentinelLog.reviewed, false));
  }

  /**
   * The newest name each sender has put on a message, one row per (channel,
   * channel user id). Senders who have never carried a name are absent, and no
   * row carries an empty one.
   *
   * Read whole rather than one sender at a time: the callers are directory
   * reads that name every account they list.
   */
  async listLatestDisplayNames(): Promise<
    Array<{ channel: string; channelUserId: string; displayName: string }>
  > {
    // Bare display_name rides SQLite's guarantee that with a lone MAX()
    // aggregate the other selected columns come from the row that supplied the
    // max — i.e. the newest message names the sender. The max is taken over the
    // named rows alone, so a later message that carried no name leaves the name
    // the sender last gave standing.
    const rows = (await this.db.all(sql`
      SELECT channel, channel_user_id AS channelUserId, display_name AS displayName,
             MAX(created_at) AS namedAt
      FROM sentinel_log
      WHERE display_name IS NOT NULL AND trim(display_name) <> ''
      GROUP BY channel, channel_user_id
    `)) as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      channel: String(row.channel),
      channelUserId: String(row.channelUserId),
      displayName: String(row.displayName),
    }));
  }

  /**
   * Every sender the log has seen, one row per (channel, channel user id), in
   * no particular order.
   *
   * The triage record is the only record Rome keeps for a channel it mirrors no
   * address book for, so this is what tells an account read that a sender is an
   * account at all, and that is the whole of what such a read wants: it names an
   * account and previews nothing, and the stream's preview is a `Messages`
   * store's own answer. So nothing is summed over a sender's rows here — a
   * newest message or a count would be work no reader renders.
   *
   * Read whole rather than one sender at a time, for the reason
   * {@link listLatestDisplayNames} gives.
   */
  async listSenders(): Promise<SentinelSender[]> {
    const rows = (await this.db.all(sql`
      SELECT DISTINCT channel, channel_user_id AS channelUserId
      FROM sentinel_log
    `)) as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      channel: String(row.channel),
      channelUserId: String(row.channelUserId),
    }));
  }

  async markReviewed(ids: string[]) {
    if (ids.length === 0) return;
    await this.db.update(sentinelLog).set({ reviewed: true }).where(inArray(sentinelLog.id, ids));
  }
}

export function createSentinelLogRepository(db: DrizzleDb) {
  return new SentinelLogRepository(db);
}
