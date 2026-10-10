import { sql } from "drizzle-orm";
import type { AppDbContext } from "@rome-os/app-runtime";

/**
 * Whether anyone sent Rome a message in a webchat, handoff, or channel
 * conversation at or after `since`. Agent replies, notifications, traces,
 * and background sessions (actions, subagents, forks) do not count, so a
 * dream's own session never makes the next one look necessary.
 */
export function hasChatSince(db: AppDbContext, since: Date): boolean {
  const cutoffSeconds = Math.floor(since.getTime() / 1000);
  const row = db.connection.get(sql`
    SELECT 1 AS found
    FROM rome_agent_messages m
    JOIN rome_sessions s ON s.id = m.session_id
    WHERE m.role = 'user'
      AND m.created_at >= ${cutoffSeconds}
      AND s.type IN ('webchat', 'webchat_handoff', 'channel')
    LIMIT 1
  `) as { found: number } | undefined;
  return row !== undefined;
}
