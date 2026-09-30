// `sentinel_log` as an {@link AccountMessages} store: the triage record, and the only
// place an exchange the sentinel handled alone is written down.

import { sql } from "drizzle-orm";
import type { DrizzleDb } from "../db/index.js";
import type { AccountMessages, MessageDetail } from "./messages.js";
import { scopePairs, sqlMessages } from "./messages-sql.js";

/**
 * What the sentinel logged, one row read as the two lines it records: what the
 * sender said, and what Rome answered when it answered at all.
 *
 * Both halves share the row's one timestamp, and the ordering puts the reply
 * above the line it answers. Each carries its own `ref`, so the two never
 * collapse to one cursor position.
 *
 * An account read keys on the sender the row names.
 */
export function sentinelLogMessages(db: DrizzleDb): AccountMessages {
  // No `channel`: the log holds every channel's triage side by side, so it is
  // scoped by the pair throughout.
  return sqlMessages({
    db,
    view(scope) {
      const addressed = scopePairs(scope.keys, sql`l.channel`, sql`l.channel_user_id`);
      if (addressed === null) return null;
      // A log row names its sender but not whether they were alone. The
      // session that recorded the same thread does, so a thread Rome knows to
      // be a group is what an account scope subtracts — a row whose thread no
      // session covers is a direct exchange until something says otherwise.
      const direct = sql`
        ${addressed}
        AND NOT EXISTS (
          SELECT 1 FROM rome_sessions s
          WHERE s.type = 'channel'
            AND s.source_channel = l.channel
            AND s.source_thread_id = l.thread_id
            AND s.source_thread_type = 'group'
        )`;
      // The log keeps the thread's id but not its name, and the reply's sender
      // is Rome, which it does not record.
      return sql`
        SELECT
          l.channel AS source,
          l.channel_user_id AS key,
          l.created_at AS at,
          0 AS outbound,
          'sentinel:' || l.id AS ref,
          l.text AS body,
          json_object(
            'senderId', l.channel_user_id,
            'senderName', l.display_name,
            'threadId', l.thread_id
          ) AS detail
        FROM sentinel_log l
        WHERE ${direct}
        UNION ALL
        SELECT
          l.channel,
          l.channel_user_id,
          l.created_at,
          1,
          'sentinel:' || l.id || ':reply',
          l.response,
          json_object('threadId', l.thread_id)
        FROM sentinel_log l
        WHERE ${direct} AND l.response IS NOT NULL AND l.response <> ''`;
    },
    detail: logDetail,
  });
}

/** Who a log line names as its sender and the thread it names, as recorded.
 *  The log keeps neither the thread's name nor whether it is a group. */
function logDetail(raw: Record<string, unknown>): MessageDetail {
  const text = (value: unknown) => (typeof value === "string" && value !== "" ? value : null);
  const detail: MessageDetail = {};
  const sender = { id: text(raw.senderId), name: text(raw.senderName) };
  if (sender.id !== null || sender.name !== null) detail.sender = sender;
  const threadId = text(raw.threadId);
  if (threadId !== null) detail.conversation = { id: threadId, name: null, kind: null };
  return detail;
}
