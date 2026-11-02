// The read model's SQL: the projections the dashboard, Dream and account
// transcripts read across Chats' lines and Agents' seats. It reads Chats
// through the relations Chats publishes (chats/lines-sql.ts), never its
// tables. Vocabulary: docs/domains/chats.md.

import type { Account } from "@rome-os/app-runtime";
import { sql, type SQL } from "drizzle-orm";
import { CHAT_LINES, CHATS } from "../chats/lines-sql.js";
import { romeSessions } from "../db/schema/system.js";

// How many lines the session's transcript holds: its chat's messages plus its
// own traces.
export const sessionLineCount = sql<number>`(
  (select count(*) from ${CHAT_LINES} m
   where m."chat_id" = "rome_sessions"."chat_id" and m."thread_id" is "rome_sessions"."thread_id")
  + (select count(*) from "rome_agent_messages" t
     where t."session_id" = "rome_sessions"."id" and t."role" = 'trace')
)`.mapWith(Number);

/** How many messages were said where the current `rome_sessions` row stands
 *  since it took its seat. */
export const seatMessageCount = sql<number>`(SELECT count(*) FROM ${CHAT_LINES} m
  WHERE m.chat_id = ${romeSessions.chatId} AND m.thread_id IS ${romeSessions.threadId}
    AND m.said_at >= ${romeSessions.createdAt})`;

/** When each of the sessions `sessionIds` names saw a line said where it
 *  stands, one row per line, as `(session_id, at)`. */
export function seatLinesSaid(sessionIds: SQL): SQL {
  return sql`SELECT s.id AS session_id, m.said_at AS at FROM ${romeSessions} s
    JOIN ${CHAT_LINES} m ON m.chat_id = s.chat_id AND m.thread_id IS s.thread_id
    WHERE s.id IN ${sessionIds}`;
}

// Whether the session's chat waits on the guardian: a card (question,
// connect-AI, app component) in a line from Rome after the guardian's last
// line, or an approval still pending in this chat. Any answer to a card is
// saved as the guardian's line, so a card after the last one is still open.
// `seq` is the order lines were recorded in, and `idx_chat_messages_place`
// makes "after the last" a range. Every reply adds an auto-approved row to `approvals`, so the
// pending thread ids are collected once per list rather than scanned per chat.
// json_valid and the object check skip rows that aren't block arrays
// (non-JSON, or legacy plain text), which would otherwise fail the whole list.
export const sessionAwaitingGuardian = sql<boolean>`(exists (
  select 1 from ${CHAT_LINES} m, json_each(m."parts") part
  where m."chat_id" = "rome_sessions"."chat_id" and m."thread_id" is "rome_sessions"."thread_id"
  and m."sender_agent" is not null and json_valid(m."parts")
  and m."seq" > coalesce((
    select max(u."seq") from ${CHAT_LINES} u
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

// The agent that answers in seat `s`, by the rules in
// docs/architecture/channels.md#an-accounts-agent, over the seat's channel
// `ch`: an account's agent answers its direct messages, and a group unless
// the chat is pinned to main. The account's main reads as null.
const ACCOUNT_AGENT = sql`CASE WHEN ch.agent IN ('main', 'core:main') THEN NULL ELSE ch.agent END`;
const ANSWERING_AGENT = sql`CASE WHEN ch.agent IS NOT NULL THEN CASE
    WHEN c.kind = 'dm' THEN ${ACCOUNT_AGENT}
    WHEN coalesce(json_type(s.channel_settings, '$.overrides.routing.agentName') = 'null', 0) = 1 THEN NULL
    WHEN coalesce(s.agent_name, 'main') IN ('main', 'core:main') THEN ${ACCOUNT_AGENT}
    ELSE s.agent_name END
  ELSE s.agent_name END`;

/** A row of {@link seatsSaidInSince}. */
export interface SeatSaidIn {
  id: string;
  name: string;
  chat_id: number;
  thread_id: string | null;
  thread_name: string | null;
  owner_key: string | null;
  archived: number;
  platform: string;
  channel: string | null;
  connection_kind: string | null;
  agent_name: string | null;
  project_name: string | null;
  project_path: string | null;
  created_at: number;
}

/** Every seat `scope` names, over the seat `s` and its chat `c`, where
 *  something was said since `cutoff` (unix seconds) and since it took its
 *  seat, the latest said first, with what the seat is: its name, owner, the
 *  channel that is its account on its chat's platform, and its answering
 *  agent. */
export function seatsSaidInSince(scope: SQL, cutoff: number): SQL {
  return sql`
    SELECT s.id, s.name, s.chat_id, s.thread_id, s.thread_name,
      s.owner_key, s.archived_at IS NOT NULL AS archived, c.platform,
      ch.id AS channel, ch.connection_kind, ${ANSWERING_AGENT} AS agent_name,
      s.project_name, s.project_path, s.created_at
    FROM rome_sessions s
    JOIN ${CHATS} c ON c.id = s.chat_id
    LEFT JOIN channels ch ON ch.platform = c.platform
      AND coalesce(ch.platform_account_id, ch.id) = s.account_id
    JOIN ${CHAT_LINES} m ON m.chat_id = s.chat_id AND m.thread_id IS s.thread_id
    WHERE ${scope} AND m.said_at >= max(${cutoff}, s.created_at)
    GROUP BY s.id
    ORDER BY max(m.said_at) DESC, max(m.id) DESC
  `;
}

/**
 * The transcript lines of `sessionIds`, as one table: what was said where
 * each session stands, from Chats, read as the session sees it, beside the
 * session's own lines (traces, and the text of a session that stands in no
 * chat). A line is the session's prompt or answer by its turn link; a line
 * with none is its agent's when its seat said it, the guardian's on the
 * dashboard, and a notification elsewhere. `line_order` puts a prompt before
 * the trace and answer of its turn within one second, and any line to Rome
 * before Rome's own.
 */
export function sessionLines(sessionIds: readonly string[]) {
  const ids = JSON.stringify(sessionIds);
  return sql`(
    SELECT m.key AS id, s.id AS session_id,
      -- A line the turn only caught up on is no part of the turn.
      CASE WHEN l.role IN ('prompt', 'answer') THEN l.turn_id END AS turn_id, l.input_state,
      CASE WHEN l.role = 'answer'
             OR (l.role IS NULL AND m.sender_agent IS NOT NULL AND m.sender_account_id IS s.account_id)
             THEN 'assistant'
           WHEN l.role = 'prompt' OR c.platform = 'webchat' THEN 'user'
           ELSE 'notification' END AS role,
      m.parts AS content, m.said_at AS created_at, m.sender_account_id AS sender_id,
      m.sender_name,
      -- A line to Rome comes first in its second, as a prompt does.
      CASE WHEN l.role = 'prompt' OR (l.role IS NULL AND m.sender_agent IS NULL) THEN 0 ELSE 2 END
        AS line_order,
      m.seq AS seq, m.sender_agent IS NOT NULL AS from_rome
    FROM rome_sessions s
    JOIN ${CHATS} c ON c.id = s.chat_id
    JOIN ${CHAT_LINES} m ON m.chat_id = s.chat_id AND m.thread_id IS s.thread_id
      -- A seat sees the place from when it joined.
      AND m.said_at >= s.created_at
    LEFT JOIN agent_turn_messages l ON l.message_id = m.id AND l.session_id = s.id
    WHERE s.id IN (SELECT value FROM json_each(${ids}))
    UNION ALL
    SELECT r.id, r.session_id, r.turn_id, NULL AS input_state, r.role,
      CASE WHEN r.role = 'trace' THEN '[]' ELSE r.content END AS content,
      r.created_at,
      -- A fork's or subagent's own prompt names its sender by its actor.
      CASE json_extract(r.actor, '$.kind') WHEN 'guardian' THEN 'guardian'
        WHEN 'visitor' THEN 'visitor:' || json_extract(r.actor, '$.accountId') END AS sender_id,
      json_extract(r.actor, '$.email') AS sender_name,
      CASE WHEN r.role = 'user' THEN 0 WHEN r.role = 'trace' THEN 1 ELSE 2 END AS line_order,
      r.rowid AS seq, (r.role = 'assistant') AS from_rome
    FROM rome_agent_messages r JOIN rome_sessions s ON s.id = r.session_id
    WHERE r.session_id IN (SELECT value FROM json_each(${ids}))
      AND (s.chat_id IS NULL OR r.role NOT IN ('user', 'assistant', 'notification'))
  )`;
}

/**
 * Rome's direct messages with the accounts `scope` names, each by the channel
 * of Rome's account it is read under, that account, the other party's
 * address, and the direct message there: each line, whether Rome said it,
 * the channel as its source, and its id for {@link accountTranscriptDetail}.
 * A group answers to no address, and a guardian chat is the guardian talking
 * to Rome, so neither is read.
 */
export function accountTranscript(
  scope: readonly { channel: string; account: Account; key: string; chatKey: string }[],
): SQL {
  const rows = sql.join(
    scope.map(
      ({ channel, account, key, chatKey }) =>
        sql`(${channel}, ${account.platform}, ${account.id}, ${key}, ${chatKey})`,
    ),
    sql`, `,
  );
  return sql`
    WITH v(channel, platform, account, key, chat) AS (VALUES ${rows})
    SELECT
      v.channel AS source,
      v.key AS key,
      m.said_at AS at,
      -- A line is from Rome when one of its agents said it, or the
      -- guardian said it through Rome's account there.
      (m.sender_agent IS NOT NULL OR m.sender_account_id IS v.account) AS outbound,
      'agent:' || m.id AS ref,
      m.parts AS body,
      -- The line, and Rome's account at its end of the direct message.
      json_array(m.id, v.account) AS detail_key
    FROM v
    JOIN ${CHATS} c ON c.key = v.chat AND c.platform = v.platform
    JOIN ${CHAT_LINES} m ON m.chat_id = c.id AND m.thread_id IS NULL
    WHERE c.kind = 'dm' AND c.platform <> 'webchat'`;
}

/** Who said transcript line `key` and in which seat's thread, as JSON. */
export function accountTranscriptDetail(key: SQL): SQL {
  return sql`(
    SELECT json_object(
      'senderId', m.sender_account_id,
      'senderName', m.sender_name,
      'chatKey', c.key,
      'platform', c.platform,
      'accountId', json_extract(${key}, '$[1]'),
      'threadName', c.name,
      'threadType', CASE c.kind WHEN 'dm' THEN 'private' ELSE c.kind END
    )
    FROM ${CHAT_LINES} m
    JOIN ${CHATS} c ON c.id = m.chat_id
    WHERE m.id = json_extract(${key}, '$[0]')
  )`;
}
