-- The Chats switch: every legacy chat row is copied into Chats' tables
-- (docs/domains/chats.md), keyed as the adapters key them today
-- (connections/chat-ids.ts), and from this release on Rome reads and writes
-- only there. The legacy rows stay until the contract migration drops them.
-- Each speaker's session row learns its chat, thread and account; a line keeps
-- the earliest time and place any of its rows had; and each line an account
-- heard is noted as reached, so a platform's redelivery is not heard twice.
--
-- A dashboard chat is a webchat direct message keyed by its session, and only
-- its prompts and answers are lines: its notices and traces stay the
-- session's own. A fork, a handoff and an action session stand in no chat.
CREATE TABLE `legacy_chat_line_ids` (
	`legacy_id` text PRIMARY KEY NOT NULL,
	`message_id` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_legacy_chat_line_ids_message` ON `legacy_chat_line_ids` (`message_id`);
--> statement-breakpoint
-- Each legacy chat session as a speaker: the chat its rows name, Rome's end
-- there, and whether it is a thread of another session's chat. A channel with
-- no record is on the platform of the connection kind it is named after, as
-- migration 0101 and platformOf in @rome/api-types/platform read it.
CREATE VIEW `legacy_chat_speakers` AS
SELECT
  r.`id` AS `session_id`,
  r.`source_channel` = 'webchat' AS `dashboard`,
  CASE WHEN r.`source_channel` = 'webchat' THEN 'webchat'
       ELSE coalesce(c.`platform`, CASE r.`source_channel` WHEN 'telegram_user' THEN 'telegram' WHEN 'wechat_user' THEN 'wechat' WHEN 'slack_bot' THEN 'slack' ELSE r.`source_channel` END) END AS `platform`,
  -- Rome's end: the account's platform id, or the channel's name while its
  -- record knows none, as the adapters name it.
  coalesce(c.`platform_account_id`, r.`source_channel`) AS `rome_end`,
  CASE WHEN r.`source_channel` = 'webchat' THEN r.`id`
       -- A row that names no type is a group, as the adapters open one,
       -- unless its address says it is a direct message: Telegram's is the
       -- other party's positive id, WhatsApp's is not a `@g.us` group.
       WHEN (r.`source_thread_type` IN ('group', 'channel') OR (r.`source_thread_type` IS NULL
         AND NOT (coalesce(c.`platform`, CASE r.`source_channel` WHEN 'telegram_user' THEN 'telegram' WHEN 'wechat_user' THEN 'wechat' WHEN 'slack_bot' THEN 'slack' ELSE r.`source_channel` END) = 'telegram' AND r.`source_thread_id` NOT GLOB '-*')
         AND NOT (coalesce(c.`platform`, CASE r.`source_channel` WHEN 'telegram_user' THEN 'telegram' WHEN 'wechat_user' THEN 'wechat' WHEN 'slack_bot' THEN 'slack' ELSE r.`source_channel` END) = 'whatsapp' AND r.`source_thread_id` NOT GLOB '*@g.us'))) THEN r.`source_thread_id`
       WHEN coalesce(c.`platform`, CASE r.`source_channel` WHEN 'telegram_user' THEN 'telegram' WHEN 'wechat_user' THEN 'wechat' WHEN 'slack_bot' THEN 'slack' ELSE r.`source_channel` END) IN ('email', 'agents') THEN r.`source_thread_id`
       -- A direct message's key names both ends. Where the platform's id for
       -- it is the other party (Telegram, WhatsApp) that id is the other end;
       -- where it is an id of its own (Feishu, Discord) the other end is
       -- whoever first wrote to Rome there.
       ELSE 'dm:' || coalesce(c.`platform_account_id`, r.`source_channel`) || ':' ||
         CASE WHEN coalesce(c.`platform`, CASE r.`source_channel` WHEN 'telegram_user' THEN 'telegram' WHEN 'wechat_user' THEN 'wechat' WHEN 'slack_bot' THEN 'slack' ELSE r.`source_channel` END) IN ('telegram', 'whatsapp')
              THEN r.`source_thread_id`
              ELSE coalesce((
                SELECT m.`sender_id` FROM `rome_agent_messages` m
                WHERE m.`session_id` = r.`id` AND m.`role` IN ('user', 'notification')
                  AND m.`sender_id` IS NOT NULL AND m.`sender_id` <> 'rome'
                ORDER BY m.`created_at`, m.`rowid` LIMIT 1), r.`source_thread_id`) END
       END AS `key`,
  CASE WHEN r.`source_channel` <> 'webchat'
        AND (r.`source_thread_type` IN ('group', 'channel') OR (r.`source_thread_type` IS NULL
         AND NOT (coalesce(c.`platform`, CASE r.`source_channel` WHEN 'telegram_user' THEN 'telegram' WHEN 'wechat_user' THEN 'wechat' WHEN 'slack_bot' THEN 'slack' ELSE r.`source_channel` END) = 'telegram' AND r.`source_thread_id` NOT GLOB '-*')
         AND NOT (coalesce(c.`platform`, CASE r.`source_channel` WHEN 'telegram_user' THEN 'telegram' WHEN 'wechat_user' THEN 'wechat' WHEN 'slack_bot' THEN 'slack' ELSE r.`source_channel` END) = 'whatsapp' AND r.`source_thread_id` NOT GLOB '*@g.us'))) THEN 'group'
       ELSE 'dm' END AS `kind`,
  CASE WHEN r.`source_channel` = 'webchat' THEN r.`name` ELSE r.`source_thread_name` END AS `name`,
  r.`created_at` AS `created_at`,
  r.`parent_session_id` IS NOT NULL AND r.`source_channel` <> 'webchat' AS `is_thread`,
  CASE WHEN r.`source_channel` = 'webchat' THEN 'agent:' || coalesce(r.`agent_name`, 'main')
       ELSE coalesce(c.`platform_account_id`, r.`source_channel`) END AS `account_id`,
  coalesce(r.`agent_name`, 'main') AS `agent`,
  -- A Telegram basic group, `-<id>` below 10^12, numbers its messages per
  -- member account, so a line's key there carries Rome's end in front
  -- (https://core.telegram.org/api/bots/ids).
  coalesce(c.`platform`, CASE r.`source_channel` WHEN 'telegram_user' THEN 'telegram' WHEN 'wechat_user' THEN 'wechat' WHEN 'slack_bot' THEN 'slack' ELSE r.`source_channel` END) = 'telegram'
    AND r.`source_thread_id` GLOB '-[1-9]*' AND NOT substr(r.`source_thread_id`, 2) GLOB '*[^0-9]*'
    AND length(r.`source_thread_id`) <= 13 AS `per_account`
FROM `rome_sessions` r
LEFT JOIN `channels` c ON c.`id` = r.`source_channel`
WHERE r.`type` = 'channel' AND r.`source_channel` IS NOT NULL AND r.`source_thread_id` IS NOT NULL;
--> statement-breakpoint
-- Each legacy row that is a line, as that line. A dashboard line is keyed by
-- its row's id; a channel line by the platform's id, or, where the platform
-- gave none, by one of Rome's own.
CREATE VIEW `legacy_chat_line_rows` AS
SELECT
  m.`id` AS `legacy_id`,
  m.`rowid` AS `legacy_seq`,
  m.`session_id` AS `session_id`,
  m.`role` AS `role`,
  r.`chat_id` AS `chat_id`,
  r.`thread_id` AS `thread_id`,
  r.`account_id` AS `account_id`,
  s.`per_account` AS `per_account`,
  CASE WHEN m.`role` = 'assistant' OR (m.`role` = 'notification' AND m.`sender_id` = 'rome')
         THEN s.`account_id`
       WHEN s.`dashboard` THEN
         -- An agent saying it on the dashboard says it as its dashboard account.
         CASE WHEN m.`sender_id` IS NOT NULL THEN 'agent:' || m.`sender_id`
              WHEN json_valid(m.`actor`) AND json_extract(m.`actor`, '$.kind') = 'visitor'
              THEN 'visitor:' || json_extract(m.`actor`, '$.accountId') ELSE 'guardian' END
       ELSE m.`sender_id` END AS `sender_account_id`,
  CASE WHEN m.`role` = 'assistant' OR (m.`role` = 'notification' AND m.`sender_id` = 'rome')
         THEN s.`agent`
       WHEN s.`dashboard` THEN m.`sender_id` END AS `sender_agent`,
  CASE WHEN s.`dashboard` AND json_valid(m.`actor`) AND json_extract(m.`actor`, '$.kind') = 'visitor'
       THEN json_extract(m.`actor`, '$.email')
       WHEN s.`dashboard` THEN NULL ELSE m.`sender_name` END AS `sender_name`,
  -- The text a line's parts say: its text parts, commentary left out.
  CASE WHEN NOT json_valid(m.`content`) OR json_type(m.`content`) <> 'array' THEN m.`content`
       ELSE coalesce((
         SELECT group_concat(json_extract(b.`value`, '$.content'), char(10))
         FROM json_each(m.`content`) b
         WHERE b.`type` = 'object' AND json_extract(b.`value`, '$.type') = 'text'
           AND coalesce(json_extract(b.`value`, '$.turnPhase'), '') <> 'commentary'), '')
       END AS `text`,
  CASE WHEN NOT json_valid(m.`content`) OR json_type(m.`content`) <> 'array'
       THEN json_array(json_object('type', 'text', 'content', m.`content`))
       ELSE m.`content` END AS `parts`,
  CASE WHEN s.`dashboard` THEN m.`id`
       WHEN m.`platform_message_id` IS NULL THEN 'rome:' || m.`id`
       -- A later part of a reply Rome sent in several messages is the reply's
       -- line, wherever another of Rome's accounts holds it.
       ELSE CASE WHEN s.`per_account` THEN s.`rome_end` || ':' ELSE '' END || coalesce((
         SELECT h.`platform_message_id` FROM `rome_agent_message_platform_ids` a
         JOIN `rome_agent_messages` h ON h.`id` = a.`message_id`
         JOIN `rome_sessions` hr ON hr.`id` = h.`session_id`
         WHERE a.`platform_message_id` = m.`platform_message_id` AND hr.`chat_id` = r.`chat_id`
           -- Where each account numbers its own lines, only its own aliases.
           AND (NOT s.`per_account` OR hr.`account_id` IS r.`account_id`)
           AND h.`platform_message_id` IS NOT NULL LIMIT 1), m.`platform_message_id`)
       END AS `key`,
  CASE WHEN m.`reply_to_platform_message_id` IS NULL THEN NULL
       ELSE CASE WHEN s.`per_account` THEN s.`rome_end` || ':' ELSE '' END
         || m.`reply_to_platform_message_id` END AS `reply_key`,
  m.`created_at` AS `said_at`,
  CASE m.`role` WHEN 'user' THEN 'prompt' WHEN 'assistant' THEN 'answer'
       WHEN 'notification' THEN CASE WHEN m.`context_injected_turn_id` IS NOT NULL THEN 'seen' END
       END AS `link_role`,
  CASE WHEN m.`role` = 'notification' THEN m.`context_injected_turn_id` ELSE m.`turn_id` END AS `link_turn_id`,
  CASE WHEN m.`role` = 'user' THEN m.`input_state` END AS `input_state`
FROM `rome_agent_messages` m
JOIN `rome_sessions` r ON r.`id` = m.`session_id`
JOIN `legacy_chat_speakers` s ON s.`session_id` = r.`id`
WHERE r.`chat_id` IS NOT NULL
  AND m.`role` IN ('user', 'assistant', 'notification')
  AND (NOT s.`dashboard` OR m.`role` IN ('user', 'assistant'));
--> statement-breakpoint
INSERT OR IGNORE INTO `chats` (`platform`, `key`, `kind`, `name`, `started_at`)
SELECT s.`platform`, s.`key`, s.`kind`, s.`name`, s.`created_at`
FROM `legacy_chat_speakers` s
WHERE NOT s.`is_thread`
ORDER BY s.`created_at`, s.`session_id`;
--> statement-breakpoint
UPDATE `rome_sessions` SET
  `chat_id` = (SELECT ch.`id` FROM `legacy_chat_speakers` s
    JOIN `chats` ch ON ch.`platform` = s.`platform` AND ch.`key` = s.`key`
    WHERE s.`session_id` = `rome_sessions`.`id`),
  `chat_platform` = (SELECT s.`platform` FROM `legacy_chat_speakers` s WHERE s.`session_id` = `rome_sessions`.`id`),
  `account_id` = (SELECT s.`account_id` FROM `legacy_chat_speakers` s WHERE s.`session_id` = `rome_sessions`.`id`)
WHERE `chat_id` IS NULL
  AND `id` IN (SELECT s.`session_id` FROM `legacy_chat_speakers` s WHERE NOT s.`is_thread`);
--> statement-breakpoint
-- A thread's speaker stands in its parent's chat, in the thread.
UPDATE `rome_sessions` SET
  `chat_id` = (SELECT p.`chat_id` FROM `rome_sessions` p WHERE p.`id` = `rome_sessions`.`parent_session_id`),
  `chat_platform` = (SELECT p.`chat_platform` FROM `rome_sessions` p WHERE p.`id` = `rome_sessions`.`parent_session_id`),
  `thread_id` = `source_thread_id`,
  `account_id` = (SELECT s.`account_id` FROM `legacy_chat_speakers` s WHERE s.`session_id` = `rome_sessions`.`id`)
WHERE `chat_id` IS NULL
  AND `id` IN (SELECT s.`session_id` FROM `legacy_chat_speakers` s WHERE s.`is_thread`);
--> statement-breakpoint
-- Where each account reaches a direct message and a thread, as the adapters
-- note it when they hear one.
INSERT OR IGNORE INTO `chat_addresses` (`platform`, `account_id`, `chat_key`, `thread_id`, `address`)
SELECT c.`platform`, r.`account_id`, c.`key`, coalesce(r.`thread_id`, ''), r.`source_thread_id`
FROM `rome_sessions` r JOIN `chats` c ON c.`id` = r.`chat_id`
WHERE c.`platform` <> 'webchat' AND r.`account_id` IS NOT NULL AND r.`source_thread_id` IS NOT NULL
  AND (c.`kind` = 'dm' OR r.`thread_id` IS NOT NULL);
--> statement-breakpoint
-- Oldest first, so a line two rows stand for keeps the earliest of them.
INSERT OR IGNORE INTO `chat_messages` (`chat_id`, `key`, `thread_id`, `sender_account_id`, `sender_agent`,
  `sender_name`, `text`, `parts`, `reply_to_message_id`, `said_at`)
SELECT v.`chat_id`, v.`key`, v.`thread_id`, v.`sender_account_id`, v.`sender_agent`, v.`sender_name`,
  v.`text`, v.`parts`, NULL, v.`said_at`
FROM `legacy_chat_line_rows` v
ORDER BY v.`said_at`, v.`legacy_seq`;
--> statement-breakpoint
INSERT OR REPLACE INTO `legacy_chat_line_ids` (`legacy_id`, `message_id`)
SELECT v.`legacy_id`, q.`id`
FROM `legacy_chat_line_rows` v JOIN `chat_messages` q ON q.`chat_id` = v.`chat_id` AND q.`key` = v.`key`;
--> statement-breakpoint
-- A line said by one of Rome's accounts is that account's, wherever another
-- account's row recorded it first.
UPDATE `chat_messages` SET
  (`sender_account_id`, `sender_agent`, `sender_name`, `text`, `parts`) = (
    SELECT v.`sender_account_id`, v.`sender_agent`, v.`sender_name`, v.`text`, v.`parts`
    FROM `legacy_chat_line_ids` i JOIN `legacy_chat_line_rows` v ON v.`legacy_id` = i.`legacy_id`
    WHERE i.`message_id` = `chat_messages`.`id` AND v.`sender_agent` IS NOT NULL
    ORDER BY v.`said_at`, v.`legacy_seq` LIMIT 1)
WHERE `sender_agent` IS NULL AND `id` IN (
  SELECT i.`message_id` FROM `legacy_chat_line_rows` v JOIN `legacy_chat_line_ids` i ON i.`legacy_id` = v.`legacy_id`
  WHERE v.`sender_agent` IS NOT NULL);
--> statement-breakpoint
-- Each speaker's link to the lines its turns took or gave, the earliest
-- standing when one speaker's rows link a line twice.
INSERT OR IGNORE INTO `agent_turn_messages` (`message_id`, `session_id`, `turn_id`, `role`, `input_state`)
SELECT i.`message_id`, v.`session_id`, v.`link_turn_id`, v.`link_role`, v.`input_state`
FROM `legacy_chat_line_rows` v JOIN `legacy_chat_line_ids` i ON i.`legacy_id` = v.`legacy_id`
WHERE v.`link_role` IS NOT NULL
ORDER BY v.`said_at`, v.`legacy_seq`;
--> statement-breakpoint
-- Each line someone else said in a channel chat reached the account whose
-- row heard it.
INSERT OR IGNORE INTO `chat_message_deliveries` (`message_id`, `account_id`)
SELECT i.`message_id`, v.`account_id`
FROM `legacy_chat_line_rows` v JOIN `legacy_chat_line_ids` i ON i.`legacy_id` = v.`legacy_id`
JOIN `chats` c ON c.`id` = v.`chat_id`
WHERE c.`platform` <> 'webchat' AND v.`role` IN ('user', 'notification')
  AND v.`sender_agent` IS NULL AND v.`account_id` IS NOT NULL;
--> statement-breakpoint
-- A line's quote, by the platform's id for it in the same chat, or by a later
-- part of a reply that line stands for.
UPDATE `chat_messages` SET `reply_to_message_id` = (
  SELECT coalesce(
    (SELECT q.`id` FROM `chat_messages` q WHERE q.`chat_id` = v.`chat_id` AND q.`key` = v.`reply_key`),
    (SELECT j.`message_id` FROM `rome_agent_message_platform_ids` a
      JOIN `rome_sessions` ar ON ar.`id` = a.`session_id`
      JOIN `legacy_chat_line_ids` j ON j.`legacy_id` = a.`message_id`
      WHERE ar.`chat_id` = v.`chat_id`
        AND (NOT v.`per_account` OR ar.`account_id` IS v.`account_id`)
        AND a.`platform_message_id` = (SELECT m.`reply_to_platform_message_id` FROM `rome_agent_messages` m
          WHERE m.`id` = v.`legacy_id`) LIMIT 1))
  FROM `legacy_chat_line_ids` i JOIN `legacy_chat_line_rows` v ON v.`legacy_id` = i.`legacy_id`
  WHERE i.`message_id` = `chat_messages`.`id` AND v.`reply_key` IS NOT NULL
  ORDER BY v.`said_at`, v.`legacy_seq` LIMIT 1)
WHERE `reply_to_message_id` IS NULL AND `id` IN (
  SELECT i.`message_id` FROM `legacy_chat_line_rows` v JOIN `legacy_chat_line_ids` i ON i.`legacy_id` = v.`legacy_id`
  WHERE v.`reply_key` IS NOT NULL);
--> statement-breakpoint
-- A speaker catches up on lines said after the second it was made. A
-- migrated speaker starts the second before its first line, so a first line
-- the platform dated before or in the second its session was made, as a
-- first message delivered late, stays in view.
UPDATE `rome_sessions` SET `created_at` = (
  SELECT min(m.`created_at`) FROM `rome_agent_messages` m WHERE m.`session_id` = `rome_sessions`.`id`) - 1
WHERE `id` IN (SELECT s.`session_id` FROM `legacy_chat_speakers` s)
  AND `created_at` >= (
    SELECT min(m.`created_at`) FROM `rome_agent_messages` m WHERE m.`session_id` = `rome_sessions`.`id`);
--> statement-breakpoint
-- Finds the lines that quote a line, so ending a long chat clears its quotes
-- in linear time.
CREATE INDEX `idx_chat_messages_reply` ON `chat_messages` (`chat_id`,`reply_to_message_id`);
--> statement-breakpoint
DROP VIEW `legacy_chat_line_rows`;
--> statement-breakpoint
DROP VIEW `legacy_chat_speakers`;
--> statement-breakpoint
DROP TABLE `legacy_chat_line_ids`;
