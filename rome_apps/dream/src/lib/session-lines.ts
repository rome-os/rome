import { sql } from "drizzle-orm";

/**
 * Every session's transcript lines as one table, over Rome's storage: what
 * was said where each session stands (`chat_messages`, read through the
 * session's turn links in `agent_turn_messages`), beside the session's own
 * lines in `rome_agent_messages` (traces, and the text of a session that
 * stands in no chat, such as a subagent or a fork). Columns: id, session_id,
 * turn_id, role ('user' | 'assistant' | 'notification' | 'trace' | ...),
 * content (parts JSON), created_at (seconds), sender_id ('rome' on a line an
 * agent of Rome said), sender_name, actor (`{"kind":"visitor"}` on a
 * visitor's dashboard line), seq (order within one second).
 *
 * A line is a session's prompt or answer by its turn link. A line with no
 * link is its agent's when its seat said it, the guardian's on the
 * dashboard, and a notification elsewhere. Mirrors `sessionLines` in
 * packages/core/src/db/repositories/webchat.ts.
 */
export const SESSION_LINES = sql`(
  SELECT m.id, s.id AS session_id,
    CASE WHEN l.role IN ('prompt', 'answer') THEN l.turn_id END AS turn_id,
    CASE WHEN l.role = 'answer'
           OR (l.role IS NULL AND m.sender_agent IS NOT NULL AND m.sender_account_id IS s.account_id)
           THEN 'assistant'
         WHEN l.role = 'prompt' OR s.source_channel = 'webchat' THEN 'user'
         ELSE 'notification' END AS role,
    m.parts AS content, m.said_at AS created_at,
    CASE WHEN m.sender_agent IS NOT NULL THEN 'rome' ELSE m.sender_account_id END AS sender_id,
    m.sender_name,
    CASE WHEN m.sender_account_id LIKE 'visitor:%' THEN '{"kind":"visitor"}' END AS actor,
    m.rowid AS seq
  FROM rome_sessions s
  JOIN chat_messages m ON m.chat_id = s.chat_id AND m.thread_id IS s.thread_id
  LEFT JOIN agent_turn_messages l ON l.message_id = m.id AND l.session_id = s.id
  UNION ALL
  SELECT r.id, r.session_id, r.turn_id, r.role, r.content, r.created_at, r.sender_id,
    r.sender_name, r.actor, r.rowid AS seq
  FROM rome_agent_messages r JOIN rome_sessions s ON s.id = r.session_id
  WHERE s.chat_id IS NULL OR r.role NOT IN ('user', 'assistant', 'notification')
)`;
