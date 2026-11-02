-- Chats' tables (docs/domains/chats.md), beside the legacy rows they are
-- copied from. Every id is an integer; the adapter's key for a chat or a line
-- sits beside it, unique on its platform or in its chat. Nothing reads these
-- tables yet. Until every writer records through Chats, the views and
-- triggers at the end keep them in step with the legacy rows; the contract
-- migration drops all three, and the legacy columns, a release later.
CREATE TABLE `chats` (
	`id` integer PRIMARY KEY NOT NULL,
	`platform` text NOT NULL,
	`key` text NOT NULL,
	`kind` text NOT NULL,
	`name` text,
	`started_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_chats_key` ON `chats` (`platform`,`key`);
--> statement-breakpoint
CREATE TABLE `chat_messages` (
	`id` integer PRIMARY KEY NOT NULL,
	`chat_id` integer NOT NULL,
	`key` text NOT NULL,
	`thread_id` text,
	`sender_account_id` text,
	`sender_agent` text,
	`sender_name` text,
	`text` text NOT NULL,
	`parts` text NOT NULL,
	`reply_to_message_id` integer,
	`said_at` integer NOT NULL,
	FOREIGN KEY (`chat_id`) REFERENCES `chats`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_chat_messages_key` ON `chat_messages` (`chat_id`,`key`);
--> statement-breakpoint
CREATE INDEX `idx_chat_messages_page` ON `chat_messages` (`chat_id`,`thread_id`,`said_at`,`id`);
--> statement-breakpoint
CREATE TABLE `agent_turn_messages` (
	`message_id` integer NOT NULL,
	`session_id` text NOT NULL,
	`turn_id` text,
	`role` text NOT NULL,
	`input_state` text,
	PRIMARY KEY(`message_id`, `session_id`),
	FOREIGN KEY (`message_id`) REFERENCES `chat_messages`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_agent_turn_messages_turn` ON `agent_turn_messages` (`session_id`,`turn_id`);
--> statement-breakpoint
CREATE TABLE `channel_addresses` (
	`platform` text NOT NULL,
	`account_id` text NOT NULL,
	`chat_key` text NOT NULL,
	`thread_id` text DEFAULT '' NOT NULL,
	`address` text NOT NULL,
	PRIMARY KEY(`platform`, `account_id`, `chat_key`, `thread_id`)
);
--> statement-breakpoint
CREATE INDEX `idx_channel_addresses_address` ON `channel_addresses` (`platform`,`account_id`,`address`);
--> statement-breakpoint
CREATE TABLE `legacy_chat_line_ids` (
	`legacy_id` text PRIMARY KEY NOT NULL,
	`message_id` integer NOT NULL,
	FOREIGN KEY (`message_id`) REFERENCES `chat_messages`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_legacy_chat_line_ids_message` ON `legacy_chat_line_ids` (`message_id`);
--> statement-breakpoint
ALTER TABLE `rome_sessions` ADD `chat_id` integer;
--> statement-breakpoint
ALTER TABLE `rome_sessions` ADD `chat_platform` text;
--> statement-breakpoint
ALTER TABLE `rome_sessions` ADD `thread_id` text;
--> statement-breakpoint
ALTER TABLE `rome_sessions` ADD `account_id` text;
--> statement-breakpoint
CREATE INDEX `idx_rome_sessions_chat` ON `rome_sessions` (`chat_id`,`thread_id`);
--> statement-breakpoint
-- Every legacy channel row as a seat of one of Rome's accounts in a chat: the
-- chat's key, Rome's account there, and whether the row is a thread under a
-- parent row. A dashboard chat is a webchat chat keyed by its own row's id. A
-- fork is a session, not a chat, until it is promoted. A direct message is
-- keyed by both ends, as the adapters key it (channels/chat-ids.ts).
CREATE VIEW `legacy_chat_seats` AS
SELECT
  r.`id` AS `session_id`,
  CASE WHEN r.`source_channel` = 'webchat' THEN 'webchat'
       ELSE coalesce(c.`platform`, r.`source_channel`) END AS `platform`,
  CASE WHEN r.`source_channel` = 'webchat' THEN r.`id`
       WHEN coalesce(r.`source_thread_type`, '') IN ('group', 'channel') THEN
         -- A Telegram basic group numbers its messages per member account,
         -- so each of Rome's accounts in it has a chat of its own.
         CASE WHEN coalesce(c.`platform`, r.`source_channel`) = 'telegram'
               AND r.`source_thread_id` GLOB '-[1-9]*' AND NOT substr(r.`source_thread_id`, 2) GLOB '*[^0-9]*'
               AND length(r.`source_thread_id`) <= 13
              THEN coalesce(c.`platform_account_id`, r.`source_channel`) || ':' || r.`source_thread_id`
              ELSE r.`source_thread_id` END
       WHEN coalesce(c.`platform`, r.`source_channel`) IN ('email', 'agents') THEN r.`source_thread_id`
       -- Where the platform's id for a direct message is the other party
       -- (Telegram, WhatsApp) it is that id; where it is an opaque DM id
       -- (Feishu p2p, Discord DM channel) the other party is whoever first
       -- wrote to Rome there.
       ELSE 'dm:' || coalesce(c.`platform_account_id`, r.`source_channel`) || ':' ||
         CASE WHEN coalesce(c.`platform`, r.`source_channel`) IN ('telegram', 'whatsapp')
              THEN r.`source_thread_id`
              ELSE coalesce((
                SELECT m.`sender_id` FROM `rome_agent_messages` m
                WHERE m.`session_id` = r.`id` AND m.`role` IN ('user', 'notification')
                  AND m.`sender_id` IS NOT NULL AND m.`sender_id` <> 'rome'
                ORDER BY m.`created_at`, m.`rowid` LIMIT 1), r.`source_thread_id`) END
       END AS `key`,
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
WHERE r.`type` IN ('channel', 'webchat_handoff') AND r.`source_channel` IS NOT NULL
  AND r.`source_thread_id` IS NOT NULL;
--> statement-breakpoint
-- Each legacy row of a seat with a chat, as the chat line it stands for. The
-- plain text of a block array is its text blocks joined. A line's key is the
-- platform's message id, or the row's own id for a dashboard line, where Rome
-- is the platform.
CREATE VIEW `legacy_chat_line_rows` AS
SELECT
  m.`id` AS `legacy_id`,
  m.`rowid` AS `legacy_seq`,
  m.`session_id` AS `session_id`,
  r.`chat_id` AS `chat_id`,
  r.`thread_id` AS `thread_id`,
  CASE WHEN m.`role` = 'assistant' OR coalesce(m.`sender_id`, '') = 'rome' THEN s.`account_id`
       WHEN r.`source_channel` = 'webchat' THEN
         CASE WHEN json_valid(m.`actor`) AND json_extract(m.`actor`, '$.kind') = 'visitor'
              THEN 'visitor:' || json_extract(m.`actor`, '$.accountId') ELSE 'guardian' END
       ELSE m.`sender_id` END AS `sender_account_id`,
  CASE WHEN m.`role` = 'assistant' OR coalesce(m.`sender_id`, '') = 'rome' THEN s.`agent` END AS `sender_agent`,
  CASE WHEN r.`source_channel` = 'webchat' AND json_valid(m.`actor`)
        AND json_extract(m.`actor`, '$.kind') = 'visitor'
       THEN json_extract(m.`actor`, '$.email') ELSE m.`sender_name` END AS `sender_name`,
  CASE WHEN NOT json_valid(m.`content`) THEN m.`content`
       WHEN json_type(m.`content`) <> 'array' THEN m.`content`
       ELSE coalesce((
         SELECT group_concat(CASE WHEN b.`type` = 'object' THEN json_extract(b.`value`, '$.content') END, char(10))
         FROM json_each(m.`content`) b
         WHERE CASE WHEN b.`type` = 'object' THEN json_extract(b.`value`, '$.type') END = 'text'), '')
       END AS `text`,
  m.`content` AS `parts`,
  coalesce(m.`platform_message_id`, m.`id`) AS `key`,
  m.`reply_to_platform_message_id` AS `reply_key`,
  m.`created_at` AS `said_at`,
  CASE m.`role` WHEN 'user' THEN 'prompt' WHEN 'assistant' THEN 'answer'
       WHEN 'notification' THEN CASE WHEN m.`context_injected_turn_id` IS NOT NULL THEN 'seen' END
       END AS `link_role`,
  CASE WHEN m.`role` = 'notification' THEN m.`context_injected_turn_id` ELSE m.`turn_id` END AS `link_turn_id`,
  m.`input_state` AS `input_state`
FROM `rome_agent_messages` m
JOIN `rome_sessions` r ON r.`id` = m.`session_id`
JOIN `legacy_chat_seats` s ON s.`session_id` = r.`id`
WHERE m.`role` <> 'trace' AND r.`chat_id` IS NOT NULL;
--> statement-breakpoint
INSERT OR IGNORE INTO `chats` (`platform`, `key`, `kind`, `name`, `started_at`)
SELECT s.`platform`, s.`key`, s.`kind`, s.`name`, s.`created_at`
FROM `legacy_chat_seats` s WHERE NOT s.`is_thread` AND 1
  AND (SELECT r.`chat_id` FROM `rome_sessions` r WHERE r.`id` = s.`session_id`) IS NULL
ORDER BY s.`created_at`, s.`session_id`;
--> statement-breakpoint
UPDATE `rome_sessions` SET
  `chat_id` = (SELECT ch.`id` FROM `legacy_chat_seats` s
    JOIN `chats` ch ON ch.`platform` = s.`platform` AND ch.`key` = s.`key`
    WHERE s.`session_id` = `rome_sessions`.`id`),
  `chat_platform` = (SELECT s.`platform` FROM `legacy_chat_seats` s WHERE s.`session_id` = `rome_sessions`.`id`),
  `account_id` = (SELECT s.`account_id` FROM `legacy_chat_seats` s WHERE s.`session_id` = `rome_sessions`.`id`)
WHERE `chat_id` IS NULL AND 1
  AND `id` IN (SELECT s.`session_id` FROM `legacy_chat_seats` s WHERE NOT s.`is_thread`);
--> statement-breakpoint
UPDATE `rome_sessions` SET
  `chat_id` = (SELECT p.`chat_id` FROM `rome_sessions` p WHERE p.`id` = `rome_sessions`.`parent_session_id`),
  `chat_platform` = (SELECT p.`chat_platform` FROM `rome_sessions` p WHERE p.`id` = `rome_sessions`.`parent_session_id`),
  `thread_id` = `source_thread_id`,
  `account_id` = (SELECT s.`account_id` FROM `legacy_chat_seats` s WHERE s.`session_id` = `rome_sessions`.`id`)
WHERE `chat_id` IS NULL AND 1
  AND `id` IN (SELECT s.`session_id` FROM `legacy_chat_seats` s WHERE s.`is_thread`);
--> statement-breakpoint
INSERT OR IGNORE INTO `channel_addresses` (`platform`, `account_id`, `chat_key`, `thread_id`, `address`)
SELECT c.`platform`, r.`account_id`, c.`key`, coalesce(r.`thread_id`, ''), r.`source_thread_id`
FROM `rome_sessions` r JOIN `chats` c ON c.`id` = r.`chat_id`
WHERE c.`platform` <> 'webchat' AND r.`account_id` IS NOT NULL AND r.`source_thread_id` IS NOT NULL
  AND (c.`kind` = 'dm' OR r.`thread_id` IS NOT NULL) AND r.`id` IN (SELECT `id` FROM `rome_sessions` WHERE 1);
--> statement-breakpoint
INSERT OR IGNORE INTO `chat_messages` (`chat_id`, `key`, `thread_id`, `sender_account_id`, `sender_agent`,
  `sender_name`, `text`, `parts`, `reply_to_message_id`, `said_at`)
SELECT v.`chat_id`, v.`key`, v.`thread_id`, v.`sender_account_id`, v.`sender_agent`, v.`sender_name`,
  v.`text`, v.`parts`, NULL, v.`said_at`
FROM `legacy_chat_line_rows` v WHERE 1
ORDER BY v.`said_at`, v.`legacy_seq`;
--> statement-breakpoint
INSERT OR REPLACE INTO `legacy_chat_line_ids` (`legacy_id`, `message_id`)
SELECT v.`legacy_id`, q.`id`
FROM `legacy_chat_line_rows` v JOIN `chat_messages` q ON q.`chat_id` = v.`chat_id` AND q.`key` = v.`key`
WHERE 1;
--> statement-breakpoint
INSERT OR REPLACE INTO `agent_turn_messages` (`message_id`, `session_id`, `turn_id`, `role`, `input_state`)
SELECT i.`message_id`, v.`session_id`, v.`link_turn_id`, v.`link_role`, v.`input_state`
FROM `legacy_chat_line_rows` v JOIN `legacy_chat_line_ids` i ON i.`legacy_id` = v.`legacy_id`
WHERE v.`link_role` IS NOT NULL AND 1
ORDER BY v.`said_at`, v.`legacy_seq`;
--> statement-breakpoint
UPDATE OR IGNORE `chat_messages` SET `reply_to_message_id` = (
  SELECT q.`id` FROM `legacy_chat_line_ids` i
  JOIN `legacy_chat_line_rows` v ON v.`legacy_id` = i.`legacy_id`
  JOIN `chat_messages` q ON q.`chat_id` = v.`chat_id` AND q.`key` = v.`reply_key`
  WHERE i.`message_id` = `chat_messages`.`id` LIMIT 1)
WHERE `reply_to_message_id` IS NULL AND `id` IN (
  SELECT i.`message_id` FROM `legacy_chat_line_rows` v JOIN `legacy_chat_line_ids` i ON i.`legacy_id` = v.`legacy_id`
  WHERE v.`reply_key` IS NOT NULL AND 1);
--> statement-breakpoint
-- Until every writer records through Chats, a legacy row written, changed or
-- deleted is copied to its chat line here, by the statements the backfill
-- above ran. A seat gets its chat with its first line, when a direct message
-- on Feishu or Discord can be keyed by who wrote first.
CREATE TRIGGER `legacy_chat_line_insert` AFTER INSERT ON `rome_agent_messages`
WHEN NEW.`role` <> 'trace'
BEGIN
  INSERT OR IGNORE INTO `chats` (`platform`, `key`, `kind`, `name`, `started_at`)
  SELECT s.`platform`, s.`key`, s.`kind`, s.`name`, s.`created_at`
  FROM `legacy_chat_seats` s WHERE NOT s.`is_thread` AND s.`session_id` IN (NEW.`session_id`, (SELECT p.`parent_session_id` FROM `rome_sessions` p WHERE p.`id` = NEW.`session_id`))
    AND (SELECT r.`chat_id` FROM `rome_sessions` r WHERE r.`id` = s.`session_id`) IS NULL
  ORDER BY s.`created_at`, s.`session_id`;
  UPDATE `rome_sessions` SET
    `chat_id` = (SELECT ch.`id` FROM `legacy_chat_seats` s
      JOIN `chats` ch ON ch.`platform` = s.`platform` AND ch.`key` = s.`key`
      WHERE s.`session_id` = `rome_sessions`.`id`),
    `chat_platform` = (SELECT s.`platform` FROM `legacy_chat_seats` s WHERE s.`session_id` = `rome_sessions`.`id`),
    `account_id` = (SELECT s.`account_id` FROM `legacy_chat_seats` s WHERE s.`session_id` = `rome_sessions`.`id`)
  WHERE `chat_id` IS NULL AND `id` IN (NEW.`session_id`, (SELECT p.`parent_session_id` FROM `rome_sessions` p WHERE p.`id` = NEW.`session_id`))
    AND `id` IN (SELECT s.`session_id` FROM `legacy_chat_seats` s WHERE NOT s.`is_thread`);
  UPDATE `rome_sessions` SET
    `chat_id` = (SELECT p.`chat_id` FROM `rome_sessions` p WHERE p.`id` = `rome_sessions`.`parent_session_id`),
    `chat_platform` = (SELECT p.`chat_platform` FROM `rome_sessions` p WHERE p.`id` = `rome_sessions`.`parent_session_id`),
    `thread_id` = `source_thread_id`,
    `account_id` = (SELECT s.`account_id` FROM `legacy_chat_seats` s WHERE s.`session_id` = `rome_sessions`.`id`)
  WHERE `chat_id` IS NULL AND `id` IN (NEW.`session_id`, (SELECT p.`parent_session_id` FROM `rome_sessions` p WHERE p.`id` = NEW.`session_id`))
    AND `id` IN (SELECT s.`session_id` FROM `legacy_chat_seats` s WHERE s.`is_thread`);
  INSERT OR IGNORE INTO `channel_addresses` (`platform`, `account_id`, `chat_key`, `thread_id`, `address`)
  SELECT c.`platform`, r.`account_id`, c.`key`, coalesce(r.`thread_id`, ''), r.`source_thread_id`
  FROM `rome_sessions` r JOIN `chats` c ON c.`id` = r.`chat_id`
  WHERE c.`platform` <> 'webchat' AND r.`account_id` IS NOT NULL AND r.`source_thread_id` IS NOT NULL
    AND (c.`kind` = 'dm' OR r.`thread_id` IS NOT NULL) AND r.`id` IN (SELECT `id` FROM `rome_sessions` WHERE `id` IN (NEW.`session_id`, (SELECT p.`parent_session_id` FROM `rome_sessions` p WHERE p.`id` = NEW.`session_id`)));
  INSERT OR IGNORE INTO `chat_messages` (`chat_id`, `key`, `thread_id`, `sender_account_id`, `sender_agent`,
    `sender_name`, `text`, `parts`, `reply_to_message_id`, `said_at`)
  SELECT v.`chat_id`, v.`key`, v.`thread_id`, v.`sender_account_id`, v.`sender_agent`, v.`sender_name`,
    v.`text`, v.`parts`, NULL, v.`said_at`
  FROM `legacy_chat_line_rows` v WHERE v.`legacy_id` = NEW.`id`
  ORDER BY v.`said_at`, v.`legacy_seq`;
  INSERT OR REPLACE INTO `legacy_chat_line_ids` (`legacy_id`, `message_id`)
  SELECT v.`legacy_id`, q.`id`
  FROM `legacy_chat_line_rows` v JOIN `chat_messages` q ON q.`chat_id` = v.`chat_id` AND q.`key` = v.`key`
  WHERE v.`legacy_id` = NEW.`id`;
  INSERT OR REPLACE INTO `agent_turn_messages` (`message_id`, `session_id`, `turn_id`, `role`, `input_state`)
  SELECT i.`message_id`, v.`session_id`, v.`link_turn_id`, v.`link_role`, v.`input_state`
  FROM `legacy_chat_line_rows` v JOIN `legacy_chat_line_ids` i ON i.`legacy_id` = v.`legacy_id`
  WHERE v.`link_role` IS NOT NULL AND v.`legacy_id` = NEW.`id`
  ORDER BY v.`said_at`, v.`legacy_seq`;
  UPDATE OR IGNORE `chat_messages` SET `reply_to_message_id` = (
    SELECT q.`id` FROM `legacy_chat_line_ids` i
    JOIN `legacy_chat_line_rows` v ON v.`legacy_id` = i.`legacy_id`
    JOIN `chat_messages` q ON q.`chat_id` = v.`chat_id` AND q.`key` = v.`reply_key`
    WHERE i.`message_id` = `chat_messages`.`id` LIMIT 1)
  WHERE `reply_to_message_id` IS NULL AND `id` IN (
    SELECT i.`message_id` FROM `legacy_chat_line_rows` v JOIN `legacy_chat_line_ids` i ON i.`legacy_id` = v.`legacy_id`
    WHERE v.`reply_key` IS NOT NULL AND v.`legacy_id` = NEW.`id`);
END;
--> statement-breakpoint
-- A changed row keeps its line, renamed in place when its key changed, unless
-- another line already holds the new key: then the row joins that line and
-- its old one goes, if no other row stands for it.
CREATE TRIGGER `legacy_chat_line_update` AFTER UPDATE OF `role`, `turn_id`, `input_state`, `actor`, `content`, `platform_message_id`, `sender_id`, `sender_name`, `reply_to_platform_message_id`, `context_injected_turn_id` ON `rome_agent_messages`
WHEN NEW.`role` <> 'trace'
BEGIN
  INSERT OR IGNORE INTO `chats` (`platform`, `key`, `kind`, `name`, `started_at`)
  SELECT s.`platform`, s.`key`, s.`kind`, s.`name`, s.`created_at`
  FROM `legacy_chat_seats` s WHERE NOT s.`is_thread` AND s.`session_id` IN (NEW.`session_id`, (SELECT p.`parent_session_id` FROM `rome_sessions` p WHERE p.`id` = NEW.`session_id`))
    AND (SELECT r.`chat_id` FROM `rome_sessions` r WHERE r.`id` = s.`session_id`) IS NULL
  ORDER BY s.`created_at`, s.`session_id`;
  UPDATE `rome_sessions` SET
    `chat_id` = (SELECT ch.`id` FROM `legacy_chat_seats` s
      JOIN `chats` ch ON ch.`platform` = s.`platform` AND ch.`key` = s.`key`
      WHERE s.`session_id` = `rome_sessions`.`id`),
    `chat_platform` = (SELECT s.`platform` FROM `legacy_chat_seats` s WHERE s.`session_id` = `rome_sessions`.`id`),
    `account_id` = (SELECT s.`account_id` FROM `legacy_chat_seats` s WHERE s.`session_id` = `rome_sessions`.`id`)
  WHERE `chat_id` IS NULL AND `id` IN (NEW.`session_id`, (SELECT p.`parent_session_id` FROM `rome_sessions` p WHERE p.`id` = NEW.`session_id`))
    AND `id` IN (SELECT s.`session_id` FROM `legacy_chat_seats` s WHERE NOT s.`is_thread`);
  UPDATE `rome_sessions` SET
    `chat_id` = (SELECT p.`chat_id` FROM `rome_sessions` p WHERE p.`id` = `rome_sessions`.`parent_session_id`),
    `chat_platform` = (SELECT p.`chat_platform` FROM `rome_sessions` p WHERE p.`id` = `rome_sessions`.`parent_session_id`),
    `thread_id` = `source_thread_id`,
    `account_id` = (SELECT s.`account_id` FROM `legacy_chat_seats` s WHERE s.`session_id` = `rome_sessions`.`id`)
  WHERE `chat_id` IS NULL AND `id` IN (NEW.`session_id`, (SELECT p.`parent_session_id` FROM `rome_sessions` p WHERE p.`id` = NEW.`session_id`))
    AND `id` IN (SELECT s.`session_id` FROM `legacy_chat_seats` s WHERE s.`is_thread`);
  INSERT OR IGNORE INTO `channel_addresses` (`platform`, `account_id`, `chat_key`, `thread_id`, `address`)
  SELECT c.`platform`, r.`account_id`, c.`key`, coalesce(r.`thread_id`, ''), r.`source_thread_id`
  FROM `rome_sessions` r JOIN `chats` c ON c.`id` = r.`chat_id`
  WHERE c.`platform` <> 'webchat' AND r.`account_id` IS NOT NULL AND r.`source_thread_id` IS NOT NULL
    AND (c.`kind` = 'dm' OR r.`thread_id` IS NOT NULL) AND r.`id` IN (SELECT `id` FROM `rome_sessions` WHERE `id` IN (NEW.`session_id`, (SELECT p.`parent_session_id` FROM `rome_sessions` p WHERE p.`id` = NEW.`session_id`)));
  UPDATE OR IGNORE `chat_messages` SET `key` = (SELECT v.`key` FROM `legacy_chat_line_rows` v WHERE v.`legacy_id` = NEW.`id`)
  WHERE `id` = (SELECT i.`message_id` FROM `legacy_chat_line_ids` i WHERE i.`legacy_id` = NEW.`id`)
    AND `chat_id` = (SELECT v.`chat_id` FROM `legacy_chat_line_rows` v WHERE v.`legacy_id` = NEW.`id`);
  DELETE FROM `agent_turn_messages` WHERE `session_id` = NEW.`session_id` AND `message_id` = (SELECT i.`message_id` FROM `legacy_chat_line_ids` i WHERE i.`legacy_id` = NEW.`id`);
  DELETE FROM `chat_messages` WHERE `id` = (SELECT i.`message_id` FROM `legacy_chat_line_ids` i WHERE i.`legacy_id` = NEW.`id`)
    AND `key` IS NOT (SELECT v.`key` FROM `legacy_chat_line_rows` v WHERE v.`legacy_id` = NEW.`id`)
    AND NOT EXISTS (SELECT 1 FROM `legacy_chat_line_ids` o WHERE o.`message_id` = `chat_messages`.`id` AND o.`legacy_id` <> NEW.`id`);
  DELETE FROM `legacy_chat_line_ids` WHERE `legacy_id` = NEW.`id`;
  INSERT OR IGNORE INTO `chat_messages` (`chat_id`, `key`, `thread_id`, `sender_account_id`, `sender_agent`,
    `sender_name`, `text`, `parts`, `reply_to_message_id`, `said_at`)
  SELECT v.`chat_id`, v.`key`, v.`thread_id`, v.`sender_account_id`, v.`sender_agent`, v.`sender_name`,
    v.`text`, v.`parts`, NULL, v.`said_at`
  FROM `legacy_chat_line_rows` v WHERE v.`legacy_id` = NEW.`id`
  ORDER BY v.`said_at`, v.`legacy_seq`;
  INSERT OR REPLACE INTO `legacy_chat_line_ids` (`legacy_id`, `message_id`)
  SELECT v.`legacy_id`, q.`id`
  FROM `legacy_chat_line_rows` v JOIN `chat_messages` q ON q.`chat_id` = v.`chat_id` AND q.`key` = v.`key`
  WHERE v.`legacy_id` = NEW.`id`;
  INSERT OR REPLACE INTO `agent_turn_messages` (`message_id`, `session_id`, `turn_id`, `role`, `input_state`)
  SELECT i.`message_id`, v.`session_id`, v.`link_turn_id`, v.`link_role`, v.`input_state`
  FROM `legacy_chat_line_rows` v JOIN `legacy_chat_line_ids` i ON i.`legacy_id` = v.`legacy_id`
  WHERE v.`link_role` IS NOT NULL AND v.`legacy_id` = NEW.`id`
  ORDER BY v.`said_at`, v.`legacy_seq`;
  UPDATE OR IGNORE `chat_messages` SET `reply_to_message_id` = (
    SELECT q.`id` FROM `legacy_chat_line_ids` i
    JOIN `legacy_chat_line_rows` v ON v.`legacy_id` = i.`legacy_id`
    JOIN `chat_messages` q ON q.`chat_id` = v.`chat_id` AND q.`key` = v.`reply_key`
    WHERE i.`message_id` = `chat_messages`.`id` LIMIT 1)
  WHERE `reply_to_message_id` IS NULL AND `id` IN (
    SELECT i.`message_id` FROM `legacy_chat_line_rows` v JOIN `legacy_chat_line_ids` i ON i.`legacy_id` = v.`legacy_id`
    WHERE v.`reply_key` IS NOT NULL AND v.`legacy_id` = NEW.`id`);
  UPDATE OR IGNORE `chat_messages` SET
    `thread_id` = (SELECT v.`thread_id` FROM `legacy_chat_line_rows` v WHERE v.`legacy_id` = NEW.`id`),
    `sender_account_id` = (SELECT v.`sender_account_id` FROM `legacy_chat_line_rows` v WHERE v.`legacy_id` = NEW.`id`),
    `sender_agent` = (SELECT v.`sender_agent` FROM `legacy_chat_line_rows` v WHERE v.`legacy_id` = NEW.`id`),
    `sender_name` = (SELECT v.`sender_name` FROM `legacy_chat_line_rows` v WHERE v.`legacy_id` = NEW.`id`),
    `text` = (SELECT v.`text` FROM `legacy_chat_line_rows` v WHERE v.`legacy_id` = NEW.`id`),
    `parts` = (SELECT v.`parts` FROM `legacy_chat_line_rows` v WHERE v.`legacy_id` = NEW.`id`),
    `reply_to_message_id` = (SELECT q.`id` FROM `legacy_chat_line_rows` v
      JOIN `chat_messages` q ON q.`chat_id` = v.`chat_id` AND q.`key` = v.`reply_key`
      WHERE v.`legacy_id` = NEW.`id`)
  WHERE `id` = (SELECT i.`message_id` FROM `legacy_chat_line_ids` i WHERE i.`legacy_id` = NEW.`id`);
END;
--> statement-breakpoint
-- A deleted row takes its seat's turn link with it, and its line once no
-- other row stands for it.
CREATE TRIGGER `legacy_chat_line_delete` AFTER DELETE ON `rome_agent_messages`
WHEN OLD.`role` <> 'trace'
BEGIN
  DELETE FROM `agent_turn_messages` WHERE `session_id` = OLD.`session_id` AND `message_id` = (SELECT i.`message_id` FROM `legacy_chat_line_ids` i WHERE i.`legacy_id` = OLD.`id`);
  DELETE FROM `chat_messages` WHERE `id` = (SELECT i.`message_id` FROM `legacy_chat_line_ids` i WHERE i.`legacy_id` = OLD.`id`)
    AND NOT EXISTS (SELECT 1 FROM `legacy_chat_line_ids` o WHERE o.`message_id` = `chat_messages`.`id` AND o.`legacy_id` <> OLD.`id`);
  DELETE FROM `legacy_chat_line_ids` WHERE `legacy_id` = OLD.`id`;
END;
--> statement-breakpoint
-- A promoted fork becomes a seat with the lines it already holds.
CREATE TRIGGER `legacy_chat_seat_promote` AFTER UPDATE OF `type`, `source_channel`, `source_thread_id` ON `rome_sessions`
WHEN NEW.`chat_id` IS NULL
BEGIN
  INSERT OR IGNORE INTO `chats` (`platform`, `key`, `kind`, `name`, `started_at`)
  SELECT s.`platform`, s.`key`, s.`kind`, s.`name`, s.`created_at`
  FROM `legacy_chat_seats` s WHERE NOT s.`is_thread` AND s.`session_id` IN (NEW.`id`, (SELECT p.`parent_session_id` FROM `rome_sessions` p WHERE p.`id` = NEW.`id`))
    AND (SELECT r.`chat_id` FROM `rome_sessions` r WHERE r.`id` = s.`session_id`) IS NULL
  ORDER BY s.`created_at`, s.`session_id`;
  UPDATE `rome_sessions` SET
    `chat_id` = (SELECT ch.`id` FROM `legacy_chat_seats` s
      JOIN `chats` ch ON ch.`platform` = s.`platform` AND ch.`key` = s.`key`
      WHERE s.`session_id` = `rome_sessions`.`id`),
    `chat_platform` = (SELECT s.`platform` FROM `legacy_chat_seats` s WHERE s.`session_id` = `rome_sessions`.`id`),
    `account_id` = (SELECT s.`account_id` FROM `legacy_chat_seats` s WHERE s.`session_id` = `rome_sessions`.`id`)
  WHERE `chat_id` IS NULL AND `id` IN (NEW.`id`, (SELECT p.`parent_session_id` FROM `rome_sessions` p WHERE p.`id` = NEW.`id`))
    AND `id` IN (SELECT s.`session_id` FROM `legacy_chat_seats` s WHERE NOT s.`is_thread`);
  UPDATE `rome_sessions` SET
    `chat_id` = (SELECT p.`chat_id` FROM `rome_sessions` p WHERE p.`id` = `rome_sessions`.`parent_session_id`),
    `chat_platform` = (SELECT p.`chat_platform` FROM `rome_sessions` p WHERE p.`id` = `rome_sessions`.`parent_session_id`),
    `thread_id` = `source_thread_id`,
    `account_id` = (SELECT s.`account_id` FROM `legacy_chat_seats` s WHERE s.`session_id` = `rome_sessions`.`id`)
  WHERE `chat_id` IS NULL AND `id` IN (NEW.`id`, (SELECT p.`parent_session_id` FROM `rome_sessions` p WHERE p.`id` = NEW.`id`))
    AND `id` IN (SELECT s.`session_id` FROM `legacy_chat_seats` s WHERE s.`is_thread`);
  INSERT OR IGNORE INTO `channel_addresses` (`platform`, `account_id`, `chat_key`, `thread_id`, `address`)
  SELECT c.`platform`, r.`account_id`, c.`key`, coalesce(r.`thread_id`, ''), r.`source_thread_id`
  FROM `rome_sessions` r JOIN `chats` c ON c.`id` = r.`chat_id`
  WHERE c.`platform` <> 'webchat' AND r.`account_id` IS NOT NULL AND r.`source_thread_id` IS NOT NULL
    AND (c.`kind` = 'dm' OR r.`thread_id` IS NOT NULL) AND r.`id` IN (SELECT `id` FROM `rome_sessions` WHERE `id` IN (NEW.`id`, (SELECT p.`parent_session_id` FROM `rome_sessions` p WHERE p.`id` = NEW.`id`)));
  INSERT OR IGNORE INTO `chat_messages` (`chat_id`, `key`, `thread_id`, `sender_account_id`, `sender_agent`,
    `sender_name`, `text`, `parts`, `reply_to_message_id`, `said_at`)
  SELECT v.`chat_id`, v.`key`, v.`thread_id`, v.`sender_account_id`, v.`sender_agent`, v.`sender_name`,
    v.`text`, v.`parts`, NULL, v.`said_at`
  FROM `legacy_chat_line_rows` v WHERE v.`session_id` = NEW.`id`
  ORDER BY v.`said_at`, v.`legacy_seq`;
  INSERT OR REPLACE INTO `legacy_chat_line_ids` (`legacy_id`, `message_id`)
  SELECT v.`legacy_id`, q.`id`
  FROM `legacy_chat_line_rows` v JOIN `chat_messages` q ON q.`chat_id` = v.`chat_id` AND q.`key` = v.`key`
  WHERE v.`session_id` = NEW.`id`;
  INSERT OR REPLACE INTO `agent_turn_messages` (`message_id`, `session_id`, `turn_id`, `role`, `input_state`)
  SELECT i.`message_id`, v.`session_id`, v.`link_turn_id`, v.`link_role`, v.`input_state`
  FROM `legacy_chat_line_rows` v JOIN `legacy_chat_line_ids` i ON i.`legacy_id` = v.`legacy_id`
  WHERE v.`link_role` IS NOT NULL AND v.`session_id` = NEW.`id`
  ORDER BY v.`said_at`, v.`legacy_seq`;
  UPDATE OR IGNORE `chat_messages` SET `reply_to_message_id` = (
    SELECT q.`id` FROM `legacy_chat_line_ids` i
    JOIN `legacy_chat_line_rows` v ON v.`legacy_id` = i.`legacy_id`
    JOIN `chat_messages` q ON q.`chat_id` = v.`chat_id` AND q.`key` = v.`reply_key`
    WHERE i.`message_id` = `chat_messages`.`id` LIMIT 1)
  WHERE `reply_to_message_id` IS NULL AND `id` IN (
    SELECT i.`message_id` FROM `legacy_chat_line_rows` v JOIN `legacy_chat_line_ids` i ON i.`legacy_id` = v.`legacy_id`
    WHERE v.`reply_key` IS NOT NULL AND v.`session_id` = NEW.`id`);
END;
--> statement-breakpoint
-- A renamed chat. A thread seat's name is its thread's, not the chat's.
CREATE TRIGGER `legacy_chat_seat_rename` AFTER UPDATE OF `name`, `source_thread_name` ON `rome_sessions`
WHEN NEW.`chat_id` IS NOT NULL AND NEW.`thread_id` IS NULL
BEGIN
  UPDATE `chats` SET `name` = CASE WHEN NEW.`source_channel` = 'webchat' THEN NEW.`name`
    ELSE NEW.`source_thread_name` END WHERE `id` = NEW.`chat_id`;
END;
--> statement-breakpoint
-- A deleted seat takes its address and turn links, and its chat once no seat is left in
-- it. Its rows, and so its lines, are deleted before it.
CREATE TRIGGER `legacy_chat_seat_delete` AFTER DELETE ON `rome_sessions`
WHEN OLD.`chat_id` IS NOT NULL
BEGIN
  DELETE FROM `channel_addresses` WHERE `account_id` = OLD.`account_id` AND `thread_id` = coalesce(OLD.`thread_id`, '')
    AND (`platform`, `chat_key`) IN (SELECT c.`platform`, c.`key` FROM `chats` c WHERE c.`id` = OLD.`chat_id`);
  DELETE FROM `agent_turn_messages` WHERE `session_id` = OLD.`id`;
  DELETE FROM `agent_turn_messages` WHERE `message_id` IN (SELECT m.`id` FROM `chat_messages` m WHERE m.`chat_id` = OLD.`chat_id`)
    AND NOT EXISTS (SELECT 1 FROM `rome_sessions` r WHERE r.`chat_id` = OLD.`chat_id`);
  DELETE FROM `legacy_chat_line_ids` WHERE `message_id` IN (SELECT m.`id` FROM `chat_messages` m WHERE m.`chat_id` = OLD.`chat_id`)
    AND NOT EXISTS (SELECT 1 FROM `rome_sessions` r WHERE r.`chat_id` = OLD.`chat_id`);
  DELETE FROM `chat_messages` WHERE `chat_id` = OLD.`chat_id`
    AND NOT EXISTS (SELECT 1 FROM `rome_sessions` r WHERE r.`chat_id` = OLD.`chat_id`);
  DELETE FROM `chats` WHERE `id` = OLD.`chat_id`
    AND NOT EXISTS (SELECT 1 FROM `rome_sessions` r WHERE r.`chat_id` = OLD.`chat_id`);
END;
