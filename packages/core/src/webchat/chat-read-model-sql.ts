// The read model's SQL: the projections the dashboard, Dream and account
// transcripts read across Chats' tables and Agents' seats. Outside Chats this
// is the only SQL that names Chats' tables, so a change to how Chats stores a
// message changes Chats and this file. Vocabulary: docs/domains/chats.md.

import { sql, type SQL } from "drizzle-orm";
import { romeSessions } from "../db/schema/system.js";

// How many lines the session's transcript holds: its chat's messages plus its
// own traces.
export const sessionLineCount = sql<number>`(
  (select count(*) from "chat_messages" m
   where m."chat_id" = "rome_sessions"."chat_id" and m."thread_id" is "rome_sessions"."thread_id")
  + (select count(*) from "rome_agent_messages" t
     where t."session_id" = "rome_sessions"."id" and t."role" = 'trace')
)`.mapWith(Number);

/** How many messages were said where the current `rome_sessions` row stands
 *  since it took its seat. */
export const seatMessageCount = sql<number>`(SELECT count(*) FROM chat_messages m
  WHERE m.chat_id = ${romeSessions.chatId} AND m.thread_id IS ${romeSessions.threadId}
    AND m.said_at >= ${romeSessions.createdAt})`;

// Whether the session's chat waits on the guardian: a card (question,
// connect-AI, app component) in a line from Rome after the guardian's last
// line, or an approval still pending in this chat. Any answer to a card is
// saved as the guardian's line, so a card after the last one is still open.
// rowid is insertion order, and `idx_chat_messages_place` makes "after the
// last" a range. Every reply adds an auto-approved row to `approvals`, so the
// pending thread ids are collected once per list rather than scanned per chat.
// json_valid and the object check skip rows that aren't block arrays
// (non-JSON, or legacy plain text), which would otherwise fail the whole list.
export const sessionAwaitingGuardian = sql<boolean>`(exists (
  select 1 from "chat_messages" m, json_each(m."parts") part
  where m."chat_id" = "rome_sessions"."chat_id" and m."thread_id" is "rome_sessions"."thread_id"
  and m."sender_agent" is not null and json_valid(m."parts")
  and m."rowid" > coalesce((
    select max(u."rowid") from "chat_messages" u
    where u."chat_id" = "rome_sessions"."chat_id" and u."thread_id" is "rome_sessions"."thread_id"
    and u."sender_agent" is null
    and exists (select 1 from "agent_turn_messages" ul where ul."message_id" = u."id" and ul."role" = 'prompt')
  ), 0)
  and case when part."type" = 'object' then json_extract(part."value", '$.type') end = 'pending_interaction'
) or "rome_sessions"."id" in (
  select json_extract(a."payload", '$.channelContext.threadId') from "approvals" a
  where a."status" = 'pending'
  and json_extract(a."payload", '$.channelContext.threadId') is not null
))`.mapWith(Boolean);

/** Every seat `scope` names where something was said since `cutoff` (unix
 *  seconds) and since it took its seat, the latest said first. */
export function seatsSaidInSince(scope: SQL, cutoff: number): SQL {
  return sql`
    SELECT s.id, s.chat_id, s.thread_id FROM rome_sessions s
    LEFT JOIN channels ch ON ch.id = s.source_channel
    JOIN chat_messages m ON m.chat_id = s.chat_id AND m.thread_id IS s.thread_id
    WHERE ${scope} AND m.said_at >= max(${cutoff}, s.created_at)
    GROUP BY s.id
    ORDER BY max(m.said_at) DESC
  `;
}

/**
 * The transcript lines of `sessionIds`, as one table: what was said where
 * each session stands, from Chats, read as the session sees it, beside the
 * session's own lines (traces, and the text of a session that stands in no
 * chat). A line is the session's prompt or answer by its turn link; a line
 * with none is its agent's when its seat said it, the guardian's on the
 * dashboard, and a notification elsewhere. `line_order` puts a prompt before
 * the trace and answer of its turn within one second.
 */
export function sessionLines(sessionIds: readonly string[]) {
  const ids = JSON.stringify(sessionIds);
  return sql`(
    SELECT m.id, s.id AS session_id,
      -- A line the turn only caught up on is no part of the turn.
      CASE WHEN l.role IN ('prompt', 'answer') THEN l.turn_id END AS turn_id, l.input_state,
      CASE WHEN l.role = 'answer'
             OR (l.role IS NULL AND m.sender_agent IS NOT NULL AND m.sender_account_id IS s.account_id)
             THEN 'assistant'
           WHEN l.role = 'prompt' OR s.source_channel = 'webchat' THEN 'user'
           ELSE 'notification' END AS role,
      m.parts AS content, m.said_at AS created_at, m.sender_account_id AS sender_id,
      m.sender_name, CASE WHEN l.role = 'prompt' THEN 0 ELSE 2 END AS line_order,
      m.rowid AS seq, m.sender_agent IS NOT NULL AS from_rome
    FROM rome_sessions s
    JOIN chat_messages m ON m.chat_id = s.chat_id AND m.thread_id IS s.thread_id
      -- A seat sees the place from when it joined.
      AND m.said_at >= s.created_at
    LEFT JOIN agent_turn_messages l ON l.message_id = m.id AND l.session_id = s.id
    WHERE s.id IN (SELECT value FROM json_each(${ids}))
    UNION ALL
    SELECT r.id, r.session_id, r.turn_id, NULL AS input_state, r.role,
      CASE WHEN r.role = 'trace' THEN '[]' ELSE r.content END AS content,
      r.created_at, r.sender_id, r.sender_name,
      CASE WHEN r.role = 'user' THEN 0 WHEN r.role = 'trace' THEN 1 ELSE 2 END AS line_order,
      r.rowid AS seq, (r.role = 'assistant' OR r.sender_id IS 'rome') AS from_rome
    FROM rome_agent_messages r JOIN rome_sessions s ON s.id = r.session_id
    WHERE r.session_id IN (SELECT value FROM json_each(${ids}))
      AND (s.chat_id IS NULL OR r.role NOT IN ('user', 'assistant', 'notification'))
  )`;
}

/** An account's direct messages with Rome in the rows `held` names: each
 *  line, whether Rome said it, and its id for {@link accountTranscriptDetail}. */
export function accountTranscript(held: SQL): SQL {
  return sql`
    SELECT
      s.source_channel AS source,
      s.source_thread_id AS key,
      m.said_at AS at,
      -- A line is from Rome when one of its agents said it, or the
      -- guardian said it through Rome's account there.
      (m.sender_agent IS NOT NULL OR m.sender_account_id IS s.account_id) AS outbound,
      'agent:' || m.id AS ref,
      m.parts AS body,
      m.id AS detail_key
    FROM rome_sessions s
    JOIN chats c ON c.id = s.chat_id
    JOIN chat_messages m ON m.chat_id = c.id AND m.thread_id IS NULL
    WHERE s.type = 'channel' AND s.thread_id IS NULL
      -- A guardian chat is the guardian talking to Rome, not a conversation
      -- with a person on an account.
      AND c.platform <> 'webchat'
      AND ${held}`;
}

/** Who said transcript line `key` and in which seat's thread, as JSON. */
export function accountTranscriptDetail(key: SQL): SQL {
  return sql`(
    SELECT json_object(
      'senderId', m.sender_account_id,
      'senderName', m.sender_name,
      'threadId', s.source_thread_id,
      'threadName', c.name,
      'threadType', CASE c.kind WHEN 'dm' THEN 'private' ELSE c.kind END
    )
    FROM chat_messages m
    JOIN chats c ON c.id = m.chat_id
    JOIN rome_sessions s ON s.chat_id = c.id AND s.thread_id IS NULL
    WHERE m.id = ${key}
    LIMIT 1
  )`;
}
