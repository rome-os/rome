import { type SQL, sql } from "drizzle-orm";
import type { AppDbContext } from "@rome-os/app-runtime";

// The connection kinds an agent can be linked to (`LINKABLE_KINDS` in
// @rome/api-types, which an app cannot import), less the guardian's own
// signed-in Telegram. A test keeps the two in step. Every other channel
// carries the guardian's own accounts (a linked WhatsApp, a WeChat login) or
// Rome's own traffic, and stays out of Dream.
export const ACCOUNT_KINDS = ["feishu", "telegram", "discord", "slack_bot"];

/** Linkable connection kinds that are the guardian's own account, which Dream
 *  leaves alone as it does their other personal accounts. */
export const GUARDIAN_OWN_KINDS = ["telegram_user"];

/** A dashboard chat, over the `rome_sessions` row named `session`. The
 *  webchat read and the start check both use it. */
export function inDashboardChat(session: string): SQL {
  const s = sql.raw(session);
  return sql`(${s}.type IN ('webchat', 'webchat_handoff')
    OR (${s}.type = 'channel' AND ${s}.source_channel = 'webchat' AND ${s}.source_thread_id = ${s}.id))`;
}

/**
 * A channel session on one of Rome's accounts, over `rome_sessions s` and
 * `channels c` LEFT JOINed on `c.id = s.source_channel`. A session whose
 * channel record is gone is judged by its channel id, which names the
 * connection kind for a connection kind's first account.
 */
export const onRomeAccount: SQL = sql`s.type = 'channel' AND coalesce(c.connection_kind, s.source_channel) IN (${sql.join(
  ACCOUNT_KINDS.map((kind) => sql`${kind}`),
  sql`, `,
)})`;

/**
 * A line someone else wrote on one of Rome's accounts. A 'notification' is a
 * line that passed outside a turn: someone the agent did not answer, or Rome
 * sending untied to one, which carries Rome's sender id.
 */
export const heardOnRomeAccount: SQL = sql`(${onRomeAccount}) AND (m.role = 'user'
  OR (m.role = 'notification' AND coalesce(m.sender_id, '') <> 'rome'))`;

/**
 * Whether anyone sent Rome a message in the dashboard's chats or on one of
 * Rome's accounts at or after `since`, which are the chats a dream reads.
 * Agent replies, Rome's own sends, traces, and background sessions (actions,
 * subagents, forks) do not count, so a dream's own session never makes the
 * next one look necessary.
 */
export function hasChatSince(db: AppDbContext, since: Date): boolean {
  const cutoffSeconds = Math.floor(since.getTime() / 1000);
  const row = db.connection.get(sql`
    SELECT 1 AS found
    FROM rome_agent_messages m
    JOIN rome_sessions s ON s.id = m.session_id
    LEFT JOIN channels c ON c.id = s.source_channel
    WHERE m.created_at >= ${cutoffSeconds}
      AND (
        (m.role = 'user' AND ${inDashboardChat("s")})
        OR (${heardOnRomeAccount})
      )
    LIMIT 1
  `) as { found: number } | undefined;
  return row !== undefined;
}
