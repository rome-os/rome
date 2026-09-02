// THROWAWAY PROTOTYPE — not wired into anything, not migrated, not exported.
// Answers one question for issue #182 route 3: does a Discord mirror table read
// through `sqlMessages` pass `testMessagesContract`, can a `before`-cursor
// backfill reach a channel's whole history, and what does keying the mirror by
// connected bot account cost. Delete once the route is decided.

import { sql } from "drizzle-orm";
import { index, integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";
import type { DrizzleDb } from "../db/index.js";
import type { Messages } from "./messages.js";
import { inList, keysIn, sqlMessages } from "./messages-sql.js";

// ---------------------------------------------------------------------------
// The mirror table
// ---------------------------------------------------------------------------

/**
 * `wa_messages` with the extra key column store-routes.md flagged.
 *
 * `bot_user_id` is the connected Discord application's own user id — which Rome
 * connection mirrored the row. Neither `wa_messages` nor `linkedin_messages`
 * carries an equivalent, because each assumes one connected account per
 * channel. Discord does not: two bot tokens can be connected at once, and both
 * can sit in the same guild channel, so without this column the same guild
 * message arrives twice under one primary key and the second write silently
 * overwrites the first.
 *
 * `dm_user_id` is the counterparty of a direct-message channel, null for a
 * guild channel. It exists because Discord keys history by channel and never by
 * author (discord.ts:114, :819), so nothing on a message row says whose account
 * history it belongs to — a guild channel's messages belong to no account's
 * read at all, exactly as a WhatsApp group's do. Production would hold this on
 * a `discord_channels` table rather than denormalized onto every message.
 */
export const discordMessagesTable = sqliteTable(
  "discord_messages_prototype",
  {
    botUserId: text("bot_user_id").notNull(),
    channelId: text("channel_id").notNull(),
    // Discord snowflakes are globally unique, so `id` alone would do — the
    // composite key is here to mirror wa_messages' shape and to make the
    // two-bot collision below representable.
    id: text("id").notNull(),
    authorId: text("author_id").notNull(),
    dmUserId: text("dm_user_id"),
    fromMe: integer("from_me", { mode: "boolean" }).notNull().default(false),
    timestamp: integer("timestamp", { mode: "timestamp" }).notNull(),
    content: text("content"),
    createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.botUserId, table.channelId, table.id] }),
    index("idx_discord_prototype_channel_ts").on(table.channelId, table.timestamp),
  ],
);

/** The same table as raw SQL, because the prototype refuses to touch
 *  `db/schema.ts` or generate a migration. Run against a `createTestDb()`. */
export function createDiscordMirrorTable(db: DrizzleDb): void {
  db.run(sql`
    CREATE TABLE IF NOT EXISTS discord_messages_prototype (
      bot_user_id TEXT NOT NULL,
      channel_id TEXT NOT NULL,
      id TEXT NOT NULL,
      author_id TEXT NOT NULL,
      dm_user_id TEXT,
      from_me INTEGER NOT NULL DEFAULT 0,
      timestamp INTEGER NOT NULL,
      content TEXT,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (bot_user_id, channel_id, id)
    )`);
  db.run(sql`
    CREATE INDEX IF NOT EXISTS idx_discord_prototype_channel_ts
      ON discord_messages_prototype (channel_id, timestamp)`);
}

// ---------------------------------------------------------------------------
// The store
// ---------------------------------------------------------------------------

export interface DiscordMessagesOptions {
  /**
   * The connected bot account this store answers for, or undefined for a store
   * that folds every connected account into one history.
   *
   * This is the whole multi-account question in one parameter. Scoped, two bots
   * cannot bleed and the store is a per-connection object — which `Channel`
   * (channel.ts) has nowhere to put, since contract C1 says one channel per
   * name. Unscoped, the store fits the channel list as it stands and the two
   * bots' views merge.
   */
  account?: string;

  /**
   * Put `bot_user_id` in the `ref` — the obvious thing to do once the mirror
   * has an account column, and the thing that makes each connection's mirror of
   * a shared guild channel a distinct entry.
   *
   * Here to be measured, not to be used. See the tests.
   */
  refCarriesAccount?: boolean;
}

/**
 * `Messages` over the Discord mirror. Structurally `whatsAppMessages`: the
 * account read keys on the DM counterparty, the conversation read keys on the
 * channel id, and everything else is `sqlMessages`.
 *
 * `ref` deliberately leaves `bot_user_id` out. Two bots in one guild channel
 * mirror the same message twice, and `sqlMessages`' `SELECT DISTINCT` folds the
 * copies back to one only if they agree on every projected column — so putting
 * the account in the ref would double a shared channel's history and its count.
 */
export function discordMessages(db: DrizzleDb, options: DiscordMessagesOptions = {}): Messages {
  return sqlMessages({
    channel: "discord",
    db,
    view(scope) {
      const column = scope.by === "account" ? sql`m.dm_user_id` : sql`m.channel_id`;
      const held = inList(column, keysIn(scope.keys));
      if (held === null) return null;
      const scoped =
        options.account === undefined
          ? held
          : sql`${held} AND m.bot_user_id = ${options.account}`;
      const ref = options.refCarriesAccount
        ? sql`m.bot_user_id || '/' || m.channel_id || ':' || m.id`
        : sql`m.channel_id || ':' || m.id`;
      return sql`
        SELECT
          'discord' AS source,
          ${column} AS key,
          m.timestamp AS at,
          CASE WHEN m.from_me THEN 1 ELSE 0 END AS outbound,
          ${ref} AS ref,
          m.content AS body
        FROM discord_messages_prototype m
        WHERE ${scoped}`;
    },
  });
}

// ---------------------------------------------------------------------------
// The backfill
// ---------------------------------------------------------------------------

/** One message as `GET /channels/{id}/messages` returns it, cut to what the
 *  mirror stores. */
export interface DiscordRestMessage {
  id: string;
  author: { id: string };
  content: string;
  /** ISO 8601, as Discord sends it. */
  timestamp: string;
}

/** The one endpoint a backfill needs. Newest-first, `before` exclusive, at most
 *  `limit` (100) per call, no total. */
export interface DiscordRest {
  channelMessages(
    channelId: string,
    query: { before?: string; limit: number },
  ): Promise<DiscordRestMessage[]>;
}

export interface DiscordBackfillChannel {
  id: string;
  /** The counterparty, for a DM channel. Absent for a guild channel. */
  dmUserId?: string;
}

export interface DiscordBackfillResult {
  /** REST calls made. The whole point of counting: the cost of the horizon. */
  calls: number;
  /** Rows the walk saw, including ones already mirrored. */
  seen: number;
  /** Rows this run actually wrote. Zero on an idempotent rerun. */
  written: number;
}

const PAGE = 100;

/**
 * Walks each channel to exhaustion through the `before` cursor and upserts what
 * it finds.
 *
 * No watermark: every run re-walks every channel from the newest message down,
 * and idempotence comes from the primary key rather than from stopping early.
 * That is the cheapest thing that satisfies both halves of the question and the
 * most expensive thing to run — see the report for what a watermark would cost
 * and why a `before`-only walk cannot have one without a second cursor.
 */
export async function backfillDiscord(
  db: DrizzleDb,
  rest: DiscordRest,
  options: { account: string; channels: readonly DiscordBackfillChannel[] },
): Promise<DiscordBackfillResult> {
  const result: DiscordBackfillResult = { calls: 0, seen: 0, written: 0 };
  const now = new Date();

  for (const channel of options.channels) {
    let before: string | undefined;
    for (;;) {
      const page = await rest.channelMessages(channel.id, { before, limit: PAGE });
      result.calls += 1;
      if (page.length === 0) break;
      result.seen += page.length;

      const changes = db
        .insert(discordMessagesTable)
        .values(
          page.map((message) => ({
            botUserId: options.account,
            channelId: channel.id,
            id: message.id,
            authorId: message.author.id,
            dmUserId: channel.dmUserId ?? null,
            fromMe: message.author.id === options.account,
            timestamp: new Date(message.timestamp),
            content: message.content,
            createdAt: now,
          })),
        )
        .onConflictDoNothing()
        .run();
      result.written += Number(changes.changes ?? 0);

      before = page[page.length - 1]?.id;
      if (page.length < PAGE) break;
    }
  }

  return result;
}
