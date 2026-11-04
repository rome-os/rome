// Where a speaker's session starts when it first stands in a chat. A
// catch-up reads what was said after the session's second
// (`TurnLinks.unseen`), so every way a speaker is placed starts it the same
// way. Vocabulary: docs/domains/participation.md#speaker.

import { sql, type SQL } from "drizzle-orm";
import type { DrizzleDb, DrizzleTx } from "./index.js";
import { romeSessions } from "./schema/system.js";

/**
 * The second a speaker first placed at `at` starts after: `at`'s own, so a
 * message heard within it is one the session has not seen, or, where the
 * account already spoke in the place, as a send that opened no session, the
 * second of its first message there, so the session reads what it said.
 */
export function firstPlacementSecond(
  exec: DrizzleDb | DrizzleTx,
  place: { chatId: number; threadId: string | null; accountId: string },
  at: Date,
): number {
  const firstOwn = exec.all<{ at: number | null }>(sql`
    SELECT min(said_at) AS at FROM chat_messages
    WHERE chat_id = ${place.chatId} AND thread_id IS ${place.threadId}
      AND sender_account_id = ${place.accountId}
  `)[0]?.at;
  return Math.min(Math.floor(at.getTime() / 1000), firstOwn ?? Number.POSITIVE_INFINITY);
}

/** `created_at` for a session placed at `second`: a second before it, while
 *  the session stands in no chat yet and starts no earlier. Once placed, its
 *  start no longer moves. */
export function placedCreatedAt(second: number): SQL {
  return sql`CASE WHEN ${romeSessions.chatId} IS NULL AND ${romeSessions.createdAt} >= ${second}
    THEN ${second - 1} ELSE ${romeSessions.createdAt} END`;
}
