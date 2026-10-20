import { type SQL, sql } from "drizzle-orm";
import type { AppDbContext } from "@rome-os/app-runtime";

// The services an agent can be linked to: `LINKABLE_SERVICES` in
// @rome/api-types, which an app cannot import. A test keeps the two equal. Every other channel carries the guardian's own
// accounts (a linked WhatsApp, a WeChat login) or Rome's own traffic, and
// stays out of Dream.
export const ACCOUNT_SERVICES = ["feishu", "telegram", "discord", "telegram_user"];

/**
 * A channel session on one of Rome's accounts, over `rome_sessions s` and
 * `channels c` LEFT JOINed on `c.id = s.source_channel`. A session whose
 * channel record is gone is judged by its channel id, which names the service
 * for a service's first account.
 */
export const onRomeAccount: SQL = sql`s.type = 'channel' AND coalesce(c.service, s.source_channel) IN (${sql.join(
  ACCOUNT_SERVICES.map((service) => sql`${service}`),
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
        (m.role = 'user' AND (
          s.type IN ('webchat', 'webchat_handoff')
          OR (s.type = 'channel' AND s.source_channel = 'webchat')
        ))
        OR (${heardOnRomeAccount})
      )
    LIMIT 1
  `) as { found: number } | undefined;
  return row !== undefined;
}
