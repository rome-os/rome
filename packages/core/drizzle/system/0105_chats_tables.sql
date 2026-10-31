CREATE TABLE `agent_turn_messages` (
	`message_id` text NOT NULL,
	`session_id` text NOT NULL,
	`turn_id` text,
	`role` text NOT NULL,
	`input_state` text,
	PRIMARY KEY(`message_id`, `session_id`),
	FOREIGN KEY (`message_id`) REFERENCES `chat_messages`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_agent_turn_messages_turn` ON `agent_turn_messages` (`session_id`,`turn_id`);--> statement-breakpoint
CREATE TABLE `chat_messages` (
	`id` text PRIMARY KEY NOT NULL,
	`chat_id` text NOT NULL,
	`thread_id` text,
	`sender_account_id` text,
	`sender_agent` text,
	`sender_name` text,
	`text` text NOT NULL,
	`parts` text NOT NULL,
	`platform_message_id` text NOT NULL,
	`reply_to_platform_message_id` text,
	`said_at` integer NOT NULL,
	FOREIGN KEY (`chat_id`) REFERENCES `chats`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_chat_messages_page` ON `chat_messages` (`chat_id`,`thread_id`,`said_at`,`id`);--> statement-breakpoint
CREATE UNIQUE INDEX `uq_chat_messages_platform` ON `chat_messages` (`chat_id`,`platform_message_id`);--> statement-breakpoint
CREATE TABLE `chats` (
	`id` text PRIMARY KEY NOT NULL,
	`platform` text NOT NULL,
	`platform_chat_id` text NOT NULL,
	`kind` text NOT NULL,
	`name` text,
	`started_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_chats_platform_chat` ON `chats` (`platform`,`platform_chat_id`);--> statement-breakpoint
ALTER TABLE `rome_sessions` ADD `chat_id` text;--> statement-breakpoint
ALTER TABLE `rome_sessions` ADD `thread_id` text;--> statement-breakpoint
ALTER TABLE `rome_sessions` ADD `account_id` text;--> statement-breakpoint
CREATE INDEX `idx_rome_sessions_chat` ON `rome_sessions` (`chat_id`,`thread_id`);--> statement-breakpoint
-- Every channel row as a seat of one of Rome's accounts in a chat: the chat's
-- key, Rome's account there, and whether the row is a thread under a parent
-- row. A dashboard chat is a webchat chat keyed by its own id. A fork is a
-- session, not a chat, until it is promoted. A direct message is keyed by
-- both ends, as the adapters key it. Read by the backfill below and dropped
-- at its end.
CREATE VIEW `_chat_seats` AS
SELECT
  r.`id` AS `session_id`,
  CASE WHEN r.`source_channel` = 'webchat' THEN 'webchat'
       ELSE coalesce(c.`platform`, r.`source_channel`) END AS `platform`,
  -- A dashboard chat's key is opaque, given below when its row is written.
  CASE WHEN r.`source_channel` = 'webchat' THEN NULL
       WHEN coalesce(r.`source_thread_type`, '') IN ('group', 'channel') THEN r.`source_thread_id`
       WHEN coalesce(c.`platform`, r.`source_channel`) IN ('email', 'agents') THEN r.`source_thread_id`
       -- A direct message is keyed by both ends. Where the platform's id is the
       -- other party (Telegram, WhatsApp) it is that id; where it is an opaque
       -- DM id (Feishu p2p, Discord DM channel) the other party is whoever
       -- first wrote to Rome there, until the adapter names it.
       ELSE 'dm:' || coalesce(c.`platform_account_id`, r.`source_channel`) || ':' ||
         CASE WHEN coalesce(c.`platform`, r.`source_channel`) IN ('telegram', 'whatsapp')
              THEN r.`source_thread_id`
              ELSE coalesce((
                SELECT m.`sender_id` FROM `rome_agent_messages` m
                WHERE m.`session_id` = r.`id` AND m.`role` IN ('user', 'notification')
                  AND m.`sender_id` IS NOT NULL AND m.`sender_id` <> 'rome'
                ORDER BY m.`created_at`, m.`rowid` LIMIT 1), r.`source_thread_id`) END
       END AS `platform_chat_id`,
  CASE WHEN r.`source_channel` <> 'webchat'
        AND coalesce(r.`source_thread_type`, '') IN ('group', 'channel') THEN 'group'
       ELSE 'dm' END AS `kind`,
  CASE WHEN r.`source_channel` = 'webchat' THEN r.`name` ELSE r.`source_thread_name` END AS `name`,
  r.`created_at` AS `created_at`,
  r.`parent_session_id` IS NOT NULL AND r.`source_channel` <> 'webchat' AS `is_thread`,
  r.`parent_session_id` AS `parent_session_id`,
  r.`source_thread_id` AS `source_thread_id`,
  CASE WHEN r.`source_channel` = 'webchat' THEN 'agent:' || coalesce(r.`agent_name`, 'main')
       ELSE coalesce(c.`platform_account_id`, r.`source_channel`) END AS `account_id`,
  coalesce(r.`agent_name`, 'main') AS `agent`,
  -- A Telegram basic group: `-<id>` below 10^12 (https://core.telegram.org/api/bots/ids).
  coalesce(c.`platform`, r.`source_channel`) = 'telegram'
    AND r.`source_thread_id` GLOB '-[1-9]*' AND NOT substr(r.`source_thread_id`, 2) GLOB '*[^0-9]*'
    AND length(r.`source_thread_id`) <= 13 AS `per_account_ids`
FROM `rome_sessions` r
LEFT JOIN `channels` c ON c.`id` = r.`source_channel`
WHERE r.`type` IN ('channel', 'webchat_handoff') AND r.`source_channel` IS NOT NULL AND r.`source_thread_id` IS NOT NULL;
--> statement-breakpoint
-- Each legacy text row as the chat message it stands for: the row itself, or
-- the copy another of Rome's accounts already recorded for the same platform
-- message. The plain text of a block array is its text blocks joined.
CREATE VIEW `_chat_message_rows` AS
SELECT
  m.`id` AS `legacy_id`,
  -- The order the legacy rows were stored in, which ties within one second
  -- keep: a line's `rowid` in `chat_messages` follows it.
  m.`rowid` AS `legacy_seq`,
  m.`session_id` AS `session_id`,
  r.`chat_id` AS `chat_id`,
  r.`thread_id` AS `thread_id`,
  CASE WHEN m.`role` = 'assistant' OR coalesce(m.`sender_id`, '') = 'rome' THEN s.`account_id`
       WHEN r.`source_channel` = 'webchat' THEN
         CASE WHEN json_extract(m.`actor`, '$.kind') = 'visitor'
              THEN 'visitor:' || json_extract(m.`actor`, '$.accountId') ELSE 'guardian' END
       ELSE m.`sender_id` END AS `sender_account_id`,
  CASE WHEN m.`role` = 'assistant' OR coalesce(m.`sender_id`, '') = 'rome' THEN s.`agent` END AS `sender_agent`,
  CASE WHEN r.`source_channel` = 'webchat' AND json_extract(m.`actor`, '$.kind') = 'visitor'
       THEN json_extract(m.`actor`, '$.email') ELSE m.`sender_name` END AS `sender_name`,
  CASE WHEN NOT json_valid(m.`content`) THEN m.`content`
       WHEN json_type(m.`content`) <> 'array' THEN m.`content`
       ELSE coalesce((
         SELECT group_concat(CASE WHEN b.`type` = 'object' THEN json_extract(b.`value`, '$.content') END, char(10))
         FROM json_each(m.`content`) b
         WHERE CASE WHEN b.`type` = 'object' THEN json_extract(b.`value`, '$.type') END = 'text'), '')
       END AS `text`,
  m.`content` AS `parts`,
  -- A Telegram basic group numbers messages per member account, so its ids
  -- carry Rome's account in front, as the adapter writes them. A line with no
  -- platform id is a dashboard line, where Rome is the platform and the line's
  -- own id stands for it.
  CASE WHEN m.`platform_message_id` IS NULL THEN m.`id`
       WHEN s.`per_account_ids` THEN s.`account_id` || ':' || m.`platform_message_id`
       ELSE m.`platform_message_id` END AS `platform_message_id`,
  CASE WHEN s.`per_account_ids` AND m.`reply_to_platform_message_id` IS NOT NULL
       THEN s.`account_id` || ':' || m.`reply_to_platform_message_id`
       ELSE m.`reply_to_platform_message_id` END AS `reply_to_platform_message_id`,
  m.`created_at` AS `said_at`,
  CASE m.`role` WHEN 'user' THEN 'prompt' WHEN 'assistant' THEN 'answer'
       WHEN 'notification' THEN CASE WHEN m.`context_injected_turn_id` IS NOT NULL THEN 'seen' END
       END AS `link_role`,
  CASE WHEN m.`role` = 'notification' THEN m.`context_injected_turn_id` ELSE m.`turn_id` END AS `link_turn_id`,
  m.`input_state` AS `input_state`
FROM `rome_agent_messages` m
JOIN `rome_sessions` r ON r.`id` = m.`session_id`
JOIN `_chat_seats` s ON s.`session_id` = r.`id`
WHERE m.`role` <> 'trace' AND r.`chat_id` IS NOT NULL;
--> statement-breakpoint
INSERT OR IGNORE INTO `chats` (`id`, `platform`, `platform_chat_id`, `kind`, `name`, `started_at`)
SELECT `session_id`, `platform`, coalesce(`platform_chat_id`, lower(hex(randomblob(16)))), `kind`,
  `name`, `created_at`
FROM `_chat_seats` WHERE NOT `is_thread` ORDER BY `created_at`, `session_id`;
--> statement-breakpoint
-- A dashboard chat's row was written under its session's id; every other seat
-- finds its chat by key, so the seats of one group share it.
UPDATE `rome_sessions` SET `chat_id` = (
  SELECT ch.`id` FROM `_chat_seats` s
  JOIN `chats` ch ON ch.`platform` = s.`platform`
    AND ch.`platform_chat_id` = coalesce(s.`platform_chat_id`,
      (SELECT w.`platform_chat_id` FROM `chats` w WHERE w.`id` = s.`session_id`))
  WHERE s.`session_id` = `rome_sessions`.`id`
) WHERE `id` IN (SELECT `session_id` FROM `_chat_seats` WHERE NOT `is_thread`);
--> statement-breakpoint
UPDATE `rome_sessions` SET
  `chat_id` = (SELECT p.`chat_id` FROM `rome_sessions` p WHERE p.`id` = `rome_sessions`.`parent_session_id`),
  `thread_id` = `source_thread_id`
WHERE `id` IN (SELECT `session_id` FROM `_chat_seats` WHERE `is_thread`);
--> statement-breakpoint
INSERT OR IGNORE INTO `chat_messages` (`id`, `chat_id`, `thread_id`, `sender_account_id`, `sender_agent`,
  `sender_name`, `text`, `parts`, `platform_message_id`, `reply_to_platform_message_id`, `said_at`)
SELECT `legacy_id`, `chat_id`, `thread_id`, `sender_account_id`, `sender_agent`, `sender_name`, `text`,
  `parts`, `platform_message_id`, `reply_to_platform_message_id`, `said_at`
FROM `_chat_message_rows` ORDER BY `said_at`, `legacy_seq`;
--> statement-breakpoint
INSERT OR IGNORE INTO `agent_turn_messages` (`message_id`, `session_id`, `turn_id`, `role`, `input_state`)
SELECT coalesce(
    (SELECT cm.`id` FROM `chat_messages` cm WHERE cm.`id` = v.`legacy_id`),
    (SELECT cm.`id` FROM `chat_messages` cm
     WHERE cm.`chat_id` = v.`chat_id` AND cm.`platform_message_id` = v.`platform_message_id`)),
  v.`session_id`, v.`link_turn_id`, v.`link_role`, v.`input_state`
FROM `_chat_message_rows` v WHERE v.`link_role` IS NOT NULL ORDER BY v.`said_at`, v.`legacy_seq`;
--> statement-breakpoint
UPDATE `rome_sessions` SET `account_id` = (
  SELECT s.`account_id` FROM `_chat_seats` s WHERE s.`session_id` = `rome_sessions`.`id`
) WHERE `id` IN (SELECT `session_id` FROM `_chat_seats`);
--> statement-breakpoint
DROP VIEW `_chat_message_rows`;
--> statement-breakpoint
DROP VIEW `_chat_seats`;
