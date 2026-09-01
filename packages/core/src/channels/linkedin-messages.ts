import { sql } from "drizzle-orm";
import type { DrizzleDb } from "../db/index.js";
import type { Messages } from "./messages.js";
import { inList, keysIn, sqlMessages } from "./messages-sql.js";

/**
 * `Messages` over the LinkedIn inbox mirror (`linkedin_messages`).
 *
 * A LinkedIn message hangs off a thread rather than off a member, which is what
 * makes the two scopes different queries rather than one query with a filter. A
 * conversation is the thread, named by LinkedIn's own id for it, so it is read
 * off the messages directly. A member's history is reached through the thread's
 * membership instead: it is the messages of the threads they are on, restricted
 * to the threads that are a conversation between two people. Both conditions
 * are needed for that — LinkedIn's own group flag is null until a thread has
 * been snapshotted, so the membership decides the threads it has not answered
 * for yet.
 *
 * Under the account scope a message is answered once for each scoped member of
 * its thread, and the read above folds those together. That is what makes a
 * person holding two member ids on one thread read one history rather than the
 * same messages twice — and, unlike picking a single member per thread, it
 * holds however many members of however many people the scope names at once,
 * which a read grouping a whole directory into one pass depends on.
 */
export function linkedInMessages(db: DrizzleDb): Messages {
  return sqlMessages({
    channel: "linkedin",
    db,
    view(scope) {
      const keys = keysIn(scope.keys);
      if (scope.by === "conversation") {
        const threads = inList(sql`m.thread_id`, keys);
        if (threads === null) return null;
        // The thread as LinkedIn holds it, group or not and however many are on
        // it: what the account scope subtracts is exactly what only a
        // conversation can name.
        return sql`
          SELECT
            'linkedin' AS source,
            m.thread_id AS key,
            coalesce(m.sent_at, m.created_at) AS at,
            CASE WHEN m.sender_is_self THEN 1 ELSE 0 END AS outbound,
            m.thread_id || ':' || m.message_id AS ref,
            m.text AS body
          FROM linkedin_messages m
          WHERE ${threads}`;
      }
      const members = inList(sql`tp.participant_id`, keys);
      if (members === null) return null;
      return sql`
        SELECT
          'linkedin' AS source,
          tp.participant_id AS key,
          coalesce(m.sent_at, m.created_at) AS at,
          CASE WHEN m.sender_is_self THEN 1 ELSE 0 END AS outbound,
          m.thread_id || ':' || m.message_id AS ref,
          m.text AS body
        FROM linkedin_messages m
        JOIN linkedin_threads t ON t.thread_id = m.thread_id
        JOIN linkedin_thread_participants tp
          ON tp.thread_id = m.thread_id AND ${members}
        WHERE coalesce(t.is_group, 0) = 0
          AND (
            SELECT count(*) FROM linkedin_thread_participants x WHERE x.thread_id = m.thread_id
          ) <= 2`;
    },
  });
}
