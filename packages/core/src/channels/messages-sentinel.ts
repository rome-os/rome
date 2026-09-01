// `sentinel_log` as a {@link Messages} store: the triage record, and the only
// place an exchange the sentinel handled alone is written down.

import { sql } from "drizzle-orm";
import type { DrizzleDb } from "../db/index.js";
import type { Messages } from "./messages.js";
import { scopePairs, sqlMessages } from "./messages-sql.js";

/**
 * What the sentinel logged, one row read as the two lines it records: what the
 * sender said, and what Rome answered when it answered at all.
 *
 * Both halves share the row's one timestamp, and the ordering puts the reply
 * above the line it answers. Each carries its own `ref`, so the two never
 * collapse to one cursor position.
 *
 * A log row names both the sender and the thread, so the two scopes are the
 * same query over two columns: an account read keys on the sender and a
 * conversation read on the thread. Only the first has a group to subtract.
 */
export function sentinelLogMessages(db: DrizzleDb): Messages {
  // No `channel`: the log holds every channel's triage side by side, so it is
  // scoped by the pair throughout.
  return sqlMessages({
    db,
    view(scope) {
      const byThread = scope.by === "conversation";
      const keyColumn = byThread ? sql`l.thread_id` : sql`l.channel_user_id`;
      const addressed = scopePairs(scope.keys, sql`l.channel`, keyColumn);
      if (addressed === null) return null;
      // A log row names its sender but not whether they were alone. The
      // session that recorded the same thread does, so a thread Rome knows to
      // be a group is what an account scope subtracts — a row whose thread no
      // session covers is a direct exchange until something says otherwise. A
      // conversation scope names the thread itself and subtracts nothing.
      const direct = byThread
        ? addressed
        : sql`
        ${addressed}
        AND NOT EXISTS (
          SELECT 1 FROM rome_sessions s
          WHERE s.type = 'channel'
            AND s.source_channel = l.channel
            AND s.source_thread_id = l.thread_id
            AND s.source_thread_type = 'group'
        )`;
      return sql`
        SELECT
          l.channel AS source,
          ${keyColumn} AS key,
          l.created_at AS at,
          0 AS outbound,
          'sentinel:' || l.id AS ref,
          l.text AS body
        FROM sentinel_log l
        WHERE ${direct}
        UNION ALL
        SELECT
          l.channel,
          ${keyColumn},
          l.created_at,
          1,
          'sentinel:' || l.id || ':reply',
          l.response
        FROM sentinel_log l
        WHERE ${direct} AND l.response IS NOT NULL AND l.response <> ''`;
    },
  });
}
