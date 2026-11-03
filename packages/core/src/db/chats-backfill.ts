// The Chats switch's backfill: each legacy chat session's rows copied into
// Chats' tables (docs/domains/chats.md), keyed as the adapters key them
// (connections/chat-ids.ts). From the switch on, Rome reads and writes only
// there; the legacy rows stay until the contract migration drops them. Each
// speaker's session row learns its chat, thread and account; and a message
// keeps the earliest time and place any of its rows had.
//
// A dashboard chat is a webchat direct message keyed by its session, and only
// its prompts and answers are messages: its notices and traces stay the
// session's own. A fork, a handoff and an action session stand in no chat.
//
// A chat is keyed by Rome's account, never by a channel's name, so a session
// moves only once the channel that heard it knows its account. It runs at
// startup once channels have learned their accounts and before any channel
// hears anything, and again whenever a channel learns its account, before
// that channel is active. Each run moves only the sessions not moved yet.

import { sql } from "drizzle-orm";
import type { DrizzleDb, DrizzleTx } from "./index.js";
import { createLogger } from "../logger.js";

const log = createLogger("chats-backfill");

/**
 * Move every legacy chat session that can move now into Chats, in one
 * transaction, and answer how many moved. A session whose channel knows no
 * account waits for a later run.
 */
export function backfillLegacyChats(db: DrizzleDb): number {
  return db.transaction((tx) => backfillLegacyChatsIn(tx));
}

/** {@link backfillLegacyChats} inside transaction `tx`, as when a channel
 *  learns its account in the write that records it. */
export function backfillLegacyChatsIn(tx: Pick<DrizzleTx, "all" | "run">): number {
  const [waiting] = tx.all<{ n: number }>(sql.raw(PENDING_COUNT));
  if (!waiting || waiting.n === 0) return 0;
  for (const statement of LEGACY_CHATS_BACKFILL) tx.run(sql.raw(statement));
  log.info("moved legacy chat sessions into Chats", { sessions: waiting.n });
  return waiting.n;
}

/** How many legacy chat sessions a run would move now. */
const PENDING_COUNT = `
SELECT count(*) AS n FROM rome_sessions r
LEFT JOIN channels c ON c.id = r.source_channel
WHERE r.type = 'channel' AND r.source_channel IS NOT NULL AND r.source_thread_id IS NOT NULL
  AND r.chat_id IS NULL
  AND (r.source_channel = 'webchat' OR c.platform_account_id IS NOT NULL)`;

/** The backfill's statements, run in order in one transaction. Its working
 *  tables and views are temporary and dropped at the end. */
export const LEGACY_CHATS_BACKFILL: readonly string[] = `
-- The legacy chat sessions this run moves: each one not in a chat yet that is
-- a dashboard chat, or stands where a channel that knows its account heard
-- it. A channel that knows none is not active, and its sessions wait for it.
CREATE TEMP TABLE legacy_chat_pending AS
SELECT r.id AS session_id FROM rome_sessions r
LEFT JOIN channels c ON c.id = r.source_channel
WHERE r.type = 'channel' AND r.source_channel IS NOT NULL AND r.source_thread_id IS NOT NULL
  AND r.chat_id IS NULL
  AND (r.source_channel = 'webchat' OR c.platform_account_id IS NOT NULL);
--> statement-breakpoint
CREATE TEMP TABLE legacy_chat_message_ids (
	legacy_id text PRIMARY KEY NOT NULL,
	message_id integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX temp.idx_legacy_chat_message_ids_message ON legacy_chat_message_ids (message_id);
--> statement-breakpoint
-- Each legacy chat session as a speaker: the chat its rows name, Rome's end
-- there, and whether it is a thread of another session's chat.
CREATE TEMP VIEW legacy_chat_speakers_view AS
SELECT
  r.id AS session_id,
  r.source_channel = 'webchat' AS dashboard,
  CASE WHEN r.source_channel = 'webchat' THEN 'webchat'
       ELSE c.platform END AS platform,
  -- Rome's end: the account's platform id.
  c.platform_account_id AS rome_end,
  CASE WHEN r.source_channel = 'webchat' THEN r.id
       -- A Telegram or WhatsApp group's address says it is one, whatever
       -- type the row names: a send opened every new address as private. A
       -- Telegram address alone decides, as a Telegram account's session
       -- names even a private chat a group. A row that names no type is a
       -- group, as the adapters open one, unless its address says it is a
       -- direct message: Telegram's is the other party's positive id,
       -- WhatsApp's is not a @g.us group.
       WHEN ((c.platform = 'telegram' AND r.source_thread_id GLOB '-*')
         OR (c.platform = 'whatsapp' AND r.source_thread_id GLOB '*@g.us')
         -- Where the address cannot say, two people writing there make it a
         -- group, whatever type a send that opened it named.
         OR (c.platform NOT IN ('telegram', 'whatsapp') AND (
           SELECT count(DISTINCT m.sender_id) FROM rome_agent_messages m
           WHERE m.session_id = r.id AND m.role IN ('user', 'notification')
             AND m.sender_id IS NOT NULL AND m.sender_id NOT IN ('rome', c.platform_account_id)) > 1)
         OR (c.platform <> 'telegram' AND r.source_thread_type IN ('group', 'channel'))
         OR (r.source_thread_type IS NULL
         AND NOT (c.platform = 'telegram' AND r.source_thread_id NOT GLOB '-*')
         AND NOT (c.platform = 'whatsapp' AND r.source_thread_id NOT GLOB '*@g.us'))) THEN r.source_thread_id
       WHEN c.platform IN ('email', 'agents') THEN r.source_thread_id
       -- A direct message's key names both ends. Where the platform's id for
       -- it is the other party (Telegram, WhatsApp) that id is the other end;
       -- where it is an id of its own (Feishu, Discord) the other end is
       -- whoever first wrote to Rome there.
       ELSE 'dm:' || c.platform_account_id || ':' ||
         CASE WHEN c.platform IN ('telegram', 'whatsapp')
              THEN r.source_thread_id
              ELSE coalesce((
                SELECT m.sender_id FROM rome_agent_messages m
                WHERE m.session_id = r.id AND m.role IN ('user', 'notification')
                  AND m.sender_id IS NOT NULL AND m.sender_id <> 'rome'
                ORDER BY m.created_at, m.rowid LIMIT 1), r.source_thread_id) END
       END AS key,
  -- An email thread is a group, as the email adapter keys one.
  CASE WHEN r.source_channel <> 'webchat'
        AND (c.platform = 'email' OR (c.platform = 'telegram' AND r.source_thread_id GLOB '-*')
         OR (c.platform = 'whatsapp' AND r.source_thread_id GLOB '*@g.us')
         OR (c.platform NOT IN ('telegram', 'whatsapp') AND (
           SELECT count(DISTINCT m.sender_id) FROM rome_agent_messages m
           WHERE m.session_id = r.id AND m.role IN ('user', 'notification')
             AND m.sender_id IS NOT NULL AND m.sender_id NOT IN ('rome', c.platform_account_id)) > 1)
         OR (c.platform <> 'telegram' AND r.source_thread_type IN ('group', 'channel'))
         OR (r.source_thread_type IS NULL
         AND NOT (c.platform = 'telegram' AND r.source_thread_id NOT GLOB '-*')
         AND NOT (c.platform = 'whatsapp' AND r.source_thread_id NOT GLOB '*@g.us'))) THEN 'group'
       ELSE 'dm' END AS kind,
  CASE WHEN r.source_channel = 'webchat' THEN r.name ELSE r.source_thread_name END AS name,
  r.created_at AS created_at,
  r.parent_session_id IS NOT NULL AND r.source_channel <> 'webchat' AS is_thread,
  CASE WHEN r.source_channel = 'webchat' THEN 'agent:' || coalesce(r.agent_name, 'main')
       ELSE c.platform_account_id END AS account_id,
  coalesce(r.agent_name, 'main') AS agent,
  -- A Telegram basic group, -<id> below 10^12, numbers its messages per
  -- member account, so a message's key there carries Rome's end in front
  -- (https://core.telegram.org/api/bots/ids).
  c.platform = 'telegram'
    AND r.source_thread_id GLOB '-[1-9]*' AND NOT substr(r.source_thread_id, 2) GLOB '*[^0-9]*'
    AND length(r.source_thread_id) <= 13 AS per_account
FROM rome_sessions r
JOIN legacy_chat_pending p ON p.session_id = r.id
LEFT JOIN channels c ON c.id = r.source_channel;
--> statement-breakpoint
-- The speakers, worked out once: every message row joins its session's, and
-- a view would work each one out again for every row. Nothing the view reads
-- changes before its last use.
CREATE TEMP TABLE legacy_chat_speakers AS SELECT * FROM legacy_chat_speakers_view;
--> statement-breakpoint
CREATE UNIQUE INDEX temp.idx_legacy_chat_speakers ON legacy_chat_speakers (session_id);
--> statement-breakpoint
-- A direct message keyed by whoever first wrote there may be a group a send
-- opened as private, where one person has written so far. Where two addresses
-- would share that key, or a chat already holds it at another address, each
-- is keyed by its address instead, as an adapter keys a direct message before
-- it knows the other end, and what it hears there next settles it.
CREATE TEMP TABLE legacy_chat_unsettled AS
SELECT s.session_id, s.rome_end, r.source_thread_id AS address
FROM legacy_chat_speakers s JOIN rome_sessions r ON r.id = s.session_id
WHERE s.kind = 'dm' AND NOT s.is_thread
  AND s.platform NOT IN ('telegram', 'whatsapp', 'email', 'agents', 'webchat')
  AND (EXISTS (
        SELECT 1 FROM legacy_chat_speakers o JOIN rome_sessions ro ON ro.id = o.session_id
        WHERE o.platform = s.platform AND o.key = s.key
          AND ro.source_thread_id IS NOT r.source_thread_id)
    OR EXISTS (
        SELECT 1 FROM chat_addresses a
        WHERE a.platform = s.platform AND a.account_id = s.account_id AND a.chat_key = s.key
          AND a.thread_id = '' AND a.address IS NOT r.source_thread_id));
--> statement-breakpoint
UPDATE legacy_chat_speakers
SET key = (SELECT 'dm:' || u.rome_end || ':' || u.address FROM legacy_chat_unsettled u
           WHERE u.session_id = legacy_chat_speakers.session_id)
WHERE session_id IN (SELECT session_id FROM legacy_chat_unsettled);
--> statement-breakpoint
DROP TABLE legacy_chat_unsettled;
--> statement-breakpoint
-- Each legacy row that is a message, as that message. A dashboard message is keyed by
-- its row's id; a channel message by the platform's id, or, where the platform
-- gave none, by one of Rome's own.
CREATE TEMP VIEW legacy_chat_message_rows_view AS
SELECT
  m.id AS legacy_id,
  m.rowid AS legacy_seq,
  m.session_id AS session_id,
  m.role AS role,
  r.chat_id AS chat_id,
  r.thread_id AS thread_id,
  r.account_id AS account_id,
  s.per_account AS per_account,
  CASE WHEN m.role = 'assistant' OR (m.role = 'notification' AND m.sender_id = 'rome')
         THEN s.account_id
       WHEN s.dashboard THEN
         -- An agent saying it on the dashboard says it as its dashboard account.
         CASE WHEN m.sender_id IS NOT NULL THEN 'agent:' || m.sender_id
              WHEN json_valid(m.actor) AND json_extract(m.actor, '$.kind') = 'visitor'
              THEN 'visitor:' || json_extract(m.actor, '$.accountId') ELSE 'guardian' END
       ELSE m.sender_id END AS sender_account_id,
  CASE WHEN m.role = 'assistant' OR (m.role = 'notification' AND m.sender_id = 'rome')
         THEN s.agent
       WHEN s.dashboard THEN m.sender_id END AS sender_agent,
  CASE WHEN s.dashboard AND json_valid(m.actor) AND json_extract(m.actor, '$.kind') = 'visitor'
       THEN json_extract(m.actor, '$.email')
       WHEN s.dashboard THEN NULL ELSE m.sender_name END AS sender_name,
  -- The text a message's parts say: its text parts, commentary left out.
  CASE WHEN NOT json_valid(m.content) OR json_type(m.content) <> 'array' THEN m.content
       ELSE coalesce((
         SELECT group_concat(json_extract(b.value, '$.content'), char(10))
         FROM json_each(m.content) b
         WHERE b.type = 'object' AND json_extract(b.value, '$.type') = 'text'
           AND coalesce(json_extract(b.value, '$.turnPhase'), '') <> 'commentary'), '')
       END AS text,
  CASE WHEN NOT json_valid(m.content) OR json_type(m.content) <> 'array'
       THEN json_array(json_object('type', 'text', 'content', m.content))
       ELSE m.content END AS parts,
  CASE WHEN s.dashboard THEN m.id
       WHEN m.platform_message_id IS NULL THEN 'rome:' || m.id
       -- A later part of a reply Rome sent in several messages is the reply's
       -- message, wherever another of Rome's accounts holds it.
       ELSE CASE WHEN s.per_account THEN s.rome_end || ':' ELSE '' END || coalesce((
         SELECT h.platform_message_id FROM rome_agent_message_platform_ids a
         JOIN rome_agent_messages h ON h.id = a.message_id
         JOIN rome_sessions hr ON hr.id = h.session_id
         WHERE a.platform_message_id = m.platform_message_id
           -- In the same chat, or at the same address on a channel that has
           -- not learned its account yet, so this copy and the one a later
           -- pass moves are one message.
           AND (hr.chat_id = r.chat_id OR (hr.chat_id IS NULL
             AND hr.source_thread_id = r.source_thread_id
             AND (SELECT c.platform FROM channels c WHERE c.id = hr.source_channel) = s.platform))
           -- Where each account numbers its own messages, only its own aliases.
           AND (NOT s.per_account OR hr.account_id IS r.account_id)
           AND h.platform_message_id IS NOT NULL LIMIT 1), m.platform_message_id)
       END AS key,
  CASE WHEN m.reply_to_platform_message_id IS NULL THEN NULL
       ELSE CASE WHEN s.per_account THEN s.rome_end || ':' ELSE '' END
         || m.reply_to_platform_message_id END AS reply_key,
  m.created_at AS said_at,
  CASE m.role WHEN 'user' THEN 'prompt' WHEN 'assistant' THEN 'answer'
       WHEN 'notification' THEN CASE WHEN m.context_injected_turn_id IS NOT NULL THEN 'seen' END
       END AS link_role,
  CASE WHEN m.role = 'notification' THEN m.context_injected_turn_id ELSE m.turn_id END AS link_turn_id,
  CASE WHEN m.role = 'user' THEN m.input_state END AS input_state
FROM rome_agent_messages m
JOIN rome_sessions r ON r.id = m.session_id
JOIN legacy_chat_speakers s ON s.session_id = r.id
WHERE r.chat_id IS NOT NULL
  AND m.role IN ('user', 'assistant', 'notification')
  AND (NOT s.dashboard OR m.role IN ('user', 'assistant'));
--> statement-breakpoint
INSERT OR IGNORE INTO chats (platform, key, kind, name, started_at)
SELECT s.platform, s.key, s.kind, s.name, s.created_at
FROM legacy_chat_speakers s
WHERE NOT s.is_thread
ORDER BY s.created_at, s.session_id;
--> statement-breakpoint
UPDATE rome_sessions SET
  chat_id = (SELECT ch.id FROM legacy_chat_speakers s
    JOIN chats ch ON ch.platform = s.platform AND ch.key = s.key
    WHERE s.session_id = rome_sessions.id),
  chat_platform = (SELECT s.platform FROM legacy_chat_speakers s WHERE s.session_id = rome_sessions.id),
  account_id = (SELECT s.account_id FROM legacy_chat_speakers s WHERE s.session_id = rome_sessions.id)
WHERE chat_id IS NULL
  AND id IN (SELECT s.session_id FROM legacy_chat_speakers s WHERE NOT s.is_thread);
--> statement-breakpoint
-- A thread's speaker stands in its parent's chat, in the thread.
UPDATE rome_sessions SET
  chat_id = (SELECT p.chat_id FROM rome_sessions p WHERE p.id = rome_sessions.parent_session_id),
  chat_platform = (SELECT p.chat_platform FROM rome_sessions p WHERE p.id = rome_sessions.parent_session_id),
  thread_id = source_thread_id,
  account_id = (SELECT s.account_id FROM legacy_chat_speakers s WHERE s.session_id = rome_sessions.id)
WHERE chat_id IS NULL
  AND id IN (SELECT s.session_id FROM legacy_chat_speakers s WHERE s.is_thread);
--> statement-breakpoint
-- Where each account reaches a direct message and a thread, as the adapters
-- note it when they hear one.
INSERT OR IGNORE INTO chat_addresses (platform, account_id, chat_key, thread_id, address)
SELECT c.platform, r.account_id, c.key, coalesce(r.thread_id, ''), r.source_thread_id
FROM rome_sessions r JOIN chats c ON c.id = r.chat_id
WHERE c.platform <> 'webchat' AND r.account_id IS NOT NULL AND r.source_thread_id IS NOT NULL
  AND (c.kind = 'dm' OR r.thread_id IS NOT NULL);
--> statement-breakpoint
-- The messages, worked out once now that each speaker stands in its chat, and
-- found by key and by row: every statement below joins on them.
CREATE TEMP TABLE legacy_chat_message_rows AS SELECT * FROM legacy_chat_message_rows_view;
--> statement-breakpoint
CREATE INDEX temp.idx_legacy_chat_message_rows_key ON legacy_chat_message_rows (chat_id, key);
--> statement-breakpoint
CREATE INDEX temp.idx_legacy_chat_message_rows_legacy ON legacy_chat_message_rows (legacy_id);
--> statement-breakpoint
-- Oldest first, so a message two rows stand for keeps the earliest of them.
INSERT OR IGNORE INTO chat_messages (chat_id, key, thread_id, sender_account_id, sender_agent,
  sender_name, text, parts, reply_to_message_id, said_at)
SELECT v.chat_id, v.key, v.thread_id, v.sender_account_id, v.sender_agent, v.sender_name,
  v.text, v.parts, NULL, v.said_at
FROM legacy_chat_message_rows v
ORDER BY v.said_at, v.legacy_seq;
--> statement-breakpoint
INSERT OR REPLACE INTO legacy_chat_message_ids (legacy_id, message_id)
SELECT v.legacy_id, q.id
FROM legacy_chat_message_rows v JOIN chat_messages q ON q.chat_id = v.chat_id AND q.key = v.key;
--> statement-breakpoint
-- A message said by one of Rome's accounts is that account's, wherever another
-- account's row recorded it first.
UPDATE chat_messages SET
  (sender_account_id, sender_agent, sender_name, text, parts) = (
    SELECT v.sender_account_id, v.sender_agent, v.sender_name, v.text, v.parts
    FROM legacy_chat_message_ids i JOIN legacy_chat_message_rows v ON v.legacy_id = i.legacy_id
    WHERE i.message_id = chat_messages.id AND v.sender_agent IS NOT NULL
    ORDER BY v.said_at, v.legacy_seq LIMIT 1)
WHERE sender_agent IS NULL AND id IN (
  SELECT i.message_id FROM legacy_chat_message_rows v JOIN legacy_chat_message_ids i ON i.legacy_id = v.legacy_id
  WHERE v.sender_agent IS NOT NULL);
--> statement-breakpoint
-- Each speaker's link to the messages its turns took or gave, the earliest
-- standing when one speaker's rows link a message twice.
INSERT OR IGNORE INTO agent_turn_messages (message_id, session_id, turn_id, role, input_state)
SELECT i.message_id, v.session_id, v.link_turn_id, v.link_role, v.input_state
FROM legacy_chat_message_rows v JOIN legacy_chat_message_ids i ON i.legacy_id = v.legacy_id
WHERE v.link_role IS NOT NULL
ORDER BY v.said_at, v.legacy_seq;
--> statement-breakpoint
-- A message's quote, by the platform's id for it in the same chat, or by a later
-- part of a reply that message stands for.
UPDATE chat_messages SET reply_to_message_id = (
  SELECT coalesce(
    (SELECT q.id FROM chat_messages q WHERE q.chat_id = v.chat_id AND q.key = v.reply_key),
    -- The reply's message by its first part's key, which finds it whether this
    -- pass or an earlier one moved it.
    (SELECT q.id FROM rome_agent_message_platform_ids a
      JOIN rome_agent_messages h ON h.id = a.message_id
      JOIN rome_sessions ar ON ar.id = h.session_id
      JOIN chat_messages q ON q.chat_id = v.chat_id
        AND q.key = CASE WHEN v.per_account THEN v.account_id || ':' ELSE '' END || h.platform_message_id
      WHERE (ar.chat_id = v.chat_id OR (ar.chat_id IS NULL
          AND ar.source_thread_id = (SELECT r.source_thread_id FROM rome_sessions r WHERE r.id = v.session_id)
          AND (SELECT c.platform FROM channels c WHERE c.id = ar.source_channel) = (
            SELECT ch.platform FROM chats ch WHERE ch.id = v.chat_id)))
        AND (NOT v.per_account OR ar.account_id IS v.account_id)
        AND h.platform_message_id IS NOT NULL
        AND a.platform_message_id = (SELECT m.reply_to_platform_message_id FROM rome_agent_messages m
          WHERE m.id = v.legacy_id) LIMIT 1))
  FROM legacy_chat_message_ids i JOIN legacy_chat_message_rows v ON v.legacy_id = i.legacy_id
  WHERE i.message_id = chat_messages.id AND v.reply_key IS NOT NULL
  ORDER BY v.said_at, v.legacy_seq LIMIT 1)
WHERE reply_to_message_id IS NULL AND id IN (
  SELECT i.message_id FROM legacy_chat_message_rows v JOIN legacy_chat_message_ids i ON i.legacy_id = v.legacy_id
  WHERE v.reply_key IS NOT NULL);
--> statement-breakpoint
-- A speaker catches up on messages said after the second it was made. A
-- migrated speaker starts the second before its first message, so a first message
-- the platform dated before or in the second its session was made, as a
-- first message delivered late, stays in view.
UPDATE rome_sessions SET created_at = (
  SELECT min(m.created_at) FROM rome_agent_messages m WHERE m.session_id = rome_sessions.id) - 1
WHERE id IN (SELECT s.session_id FROM legacy_chat_speakers s)
  AND created_at >= (
    SELECT min(m.created_at) FROM rome_agent_messages m WHERE m.session_id = rome_sessions.id);
--> statement-breakpoint
-- A Concierge task points back to the message its legacy source row became.
UPDATE concierge_tasks SET
  source_message_id = (
    SELECT i.message_id FROM legacy_chat_message_ids i
    WHERE i.legacy_id = concierge_tasks.legacy_source_message_id),
  legacy_source_message_id = NULL
WHERE legacy_source_message_id IN (SELECT legacy_id FROM legacy_chat_message_ids);
--> statement-breakpoint
DROP TABLE legacy_chat_message_rows;
--> statement-breakpoint
DROP VIEW legacy_chat_message_rows_view;
--> statement-breakpoint
DROP TABLE legacy_chat_speakers;
--> statement-breakpoint
DROP VIEW legacy_chat_speakers_view;
--> statement-breakpoint
DROP TABLE legacy_chat_message_ids;
--> statement-breakpoint
DROP TABLE legacy_chat_pending;
`
  .split("--> statement-breakpoint")
  .map((statement) => statement.trim())
  .filter(Boolean);
