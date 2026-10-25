import { inArray, sql } from "drizzle-orm";
import { romeAgentMessages, romeSessions } from "../schema.js";
import { TRACE_ACTIVITY_ROLES } from "../../webchat/trace-retention.js";

/** Omit ids only for the daily archive scan. UNION also terminates cyclic lineages. */
export function traceSessionActivitySql(sessionIds?: readonly string[]) {
  return sql`
    WITH RECURSIVE ancestors(session_id, ancestor_id, parent_id) AS (
      SELECT id, id, parent_session_id FROM ${romeSessions}
      ${sessionIds ? sql`WHERE ${inArray(romeSessions.id, [...new Set(sessionIds)])}` : sql``}
      UNION
      SELECT ancestors.session_id, parent.id, parent.parent_session_id
      FROM ancestors JOIN ${romeSessions} AS parent ON parent.id = ancestors.parent_id
    ),
    activity AS MATERIALIZED (
      SELECT session_id, max(created_at) AS last_message_at FROM ${romeAgentMessages}
      WHERE session_id IN (SELECT ancestor_id FROM ancestors)
        AND ${inArray(romeAgentMessages.role, TRACE_ACTIVITY_ROLES)}
      GROUP BY session_id
    )
    SELECT ancestors.session_id AS sessionId, max(activity.last_message_at) AS lastMessageAt
    FROM ancestors JOIN activity ON activity.session_id = ancestors.ancestor_id
    GROUP BY ancestors.session_id
  `;
}
