import { sql } from "drizzle-orm";
import type { DrizzleDb } from "../db/index.js";
import {
  LinkedInStoreRepository,
  linkedInHistoryJson,
  linkedInHistoryRow,
} from "../db/repositories/linkedin-store.js";
import { linkedInHistoryMessage } from "./linkedin-history.js";
import { channelMessageDetail, queryLimit, querySince, type Messages } from "./messages.js";
import { inList, keysIn, sqlMessages } from "./messages-sql.js";

/**
 * `Messages` over the LinkedIn inbox mirror (`linkedin_messages`).
 *
 * `query` reads every thread, with the thread's name joined from
 * `linkedin_threads`.
 *
 * A LinkedIn message hangs off a thread rather than off a member, so a member's
 * history is reached through the thread's membership: it is the messages of the
 * threads they are on, restricted to the threads that are a conversation
 * between two people. Both conditions are needed for that — LinkedIn's own
 * group flag is null until a thread has been snapshotted, so the membership
 * decides the threads it has not answered for yet.
 *
 * Under the account scope a message is answered once for each scoped member of
 * its thread, and the read above folds those together. That is what makes a
 * person holding two member ids on one thread read one history rather than the
 * same messages twice — and, unlike picking a single member per thread, it
 * holds however many members of however many people the scope names at once,
 * which a read grouping a whole directory into one pass depends on.
 *
 * Both reads describe a message through the same row mapper, so a line reads
 * the same sender and thread through either. The sender's id is the member id
 * in the profile URL the mirror keeps.
 */
export function linkedInMessages(db: DrizzleDb): Messages {
  const mirror = new LinkedInStoreRepository(db);
  return {
    async query({ conversationId, since, limit }) {
      const rows = await mirror.fetchHistory(
        conversationId ?? null,
        querySince(since),
        queryLimit(limit),
      );
      // The mirror answers oldest first; the port answers newest first.
      return rows.reverse().slice(0, queryLimit(limit)).map(linkedInHistoryMessage);
    },
    byAccount: sqlMessages({
      channel: "linkedin",
      db,
      view(scope) {
        const members = inList(sql`tp.participant_id`, keysIn(scope.keys));
        if (members === null) return null;
        return sql`
          SELECT
            'linkedin' AS source,
            tp.participant_id AS key,
            coalesce(m.sent_at, m.created_at) AS at,
            CASE WHEN m.sender_is_self THEN 1 ELSE 0 END AS outbound,
            m.thread_id || ':' || m.message_id AS ref,
            m.text AS body,
            ${linkedInHistoryJson()} AS detail
          FROM linkedin_messages m
          JOIN linkedin_threads t ON t.thread_id = m.thread_id
          JOIN linkedin_thread_participants tp
            ON tp.thread_id = m.thread_id AND ${members}
          WHERE coalesce(t.is_group, 0) = 0
            AND (
              SELECT count(*) FROM linkedin_thread_participants x WHERE x.thread_id = m.thread_id
            ) <= 2`;
      },
      detail: (raw) => channelMessageDetail(linkedInHistoryMessage(linkedInHistoryRow(raw))),
    }),
  };
}
