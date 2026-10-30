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
CREATE TABLE `chat_message_deliveries` (
	`message_id` text PRIMARY KEY NOT NULL,
	`state` text NOT NULL,
	`error` text,
	`at` integer NOT NULL,
	FOREIGN KEY (`message_id`) REFERENCES `chat_messages`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `chat_message_platform_ids` (
	`chat_id` text NOT NULL,
	`platform_message_id` text NOT NULL,
	`message_id` text NOT NULL,
	PRIMARY KEY(`chat_id`, `platform_message_id`),
	FOREIGN KEY (`chat_id`) REFERENCES `chats`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`message_id`) REFERENCES `chat_messages`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `chat_messages` (
	`id` text PRIMARY KEY NOT NULL,
	`chat_id` text NOT NULL,
	`thread_id` text,
	`sender_account_id` text,
	`sender_agent` text,
	`sender_name` text,
	`text` text NOT NULL,
	`parts` text NOT NULL,
	`platform_message_id` text,
	`reply_to_platform_message_id` text,
	`said_at` integer NOT NULL,
	FOREIGN KEY (`chat_id`) REFERENCES `chats`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_chat_messages_page` ON `chat_messages` (`chat_id`,`thread_id`,`said_at`,`id`);--> statement-breakpoint
CREATE INDEX `idx_chat_messages_place` ON `chat_messages` (`chat_id`,`thread_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `uq_chat_messages_platform` ON `chat_messages` (`chat_id`,`platform_message_id`) WHERE "chat_messages"."platform_message_id" IS NOT NULL;--> statement-breakpoint
CREATE TABLE `chat_participants` (
	`chat_id` text NOT NULL,
	`account_id` text NOT NULL,
	`since` integer NOT NULL,
	PRIMARY KEY(`chat_id`, `account_id`),
	FOREIGN KEY (`chat_id`) REFERENCES `chats`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_chat_participants_account` ON `chat_participants` (`account_id`);--> statement-breakpoint
CREATE TABLE `chat_threads` (
	`chat_id` text NOT NULL,
	`platform_thread_id` text NOT NULL,
	`name` text,
	`opened_from_platform_message_id` text,
	`started_at` integer NOT NULL,
	PRIMARY KEY(`chat_id`, `platform_thread_id`),
	FOREIGN KEY (`chat_id`) REFERENCES `chats`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
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
CREATE INDEX `idx_chats_platform_name` ON `chats` (`platform`,`name`);--> statement-breakpoint
ALTER TABLE `rome_sessions` ADD `chat_id` text;--> statement-breakpoint
ALTER TABLE `rome_sessions` ADD `thread_id` text;--> statement-breakpoint
CREATE INDEX `idx_rome_sessions_chat` ON `rome_sessions` (`chat_id`,`thread_id`);--> statement-breakpoint
-- Every channel row as a seat of one of Rome's accounts in a chat: the chat's
-- key, Rome's account there, and whether the row is a thread under a parent
-- row. A dashboard chat is a webchat chat keyed by its own id, forks
-- included. A direct message on a platform whose id names only the other
-- party is keyed by both ends. Shared by the backfill below and the mirror
-- triggers, and dropped with them at the contract step.
CREATE VIEW `_chat_seats` AS
SELECT
  r.`id` AS `session_id`,
  CASE WHEN r.`source_channel` = 'webchat' THEN 'webchat'
       ELSE coalesce(c.`platform`, r.`source_channel`) END AS `platform`,
  CASE WHEN r.`source_channel` = 'webchat' THEN r.`id`
       WHEN coalesce(r.`source_thread_type`, '') IN ('group', 'channel') THEN r.`source_thread_id`
       WHEN coalesce(c.`platform`, r.`source_channel`) IN ('telegram', 'whatsapp')
         THEN 'dm:' || coalesce(c.`platform_account_id`, r.`source_channel`) || ':' || r.`source_thread_id`
       ELSE r.`source_thread_id` END AS `platform_chat_id`,
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
  CASE WHEN r.`source_channel` = 'webchat' THEN coalesce(r.`agent_name`, 'main')
       ELSE r.`agent_name` END AS `agent`
FROM `rome_sessions` r
LEFT JOIN `channels` c ON c.`id` = r.`source_channel`
WHERE r.`type` = 'channel' AND r.`source_channel` IS NOT NULL AND r.`source_thread_id` IS NOT NULL;
--> statement-breakpoint
-- Each legacy text row as the chat message it stands for: the row itself, or
-- the copy another of Rome's accounts already recorded for the same platform
-- message. The plain text of a block array is its text blocks joined.
CREATE VIEW `_chat_message_rows` AS
SELECT
  m.`id` AS `legacy_id`,
  m.`session_id` AS `session_id`,
  r.`chat_id` AS `chat_id`,
  r.`thread_id` AS `thread_id`,
  m.`role` = 'assistant' OR coalesce(m.`sender_id`, '') = 'rome' AS `from_rome`,
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
  m.`platform_message_id` AS `platform_message_id`,
  m.`reply_to_platform_message_id` AS `reply_to_platform_message_id`,
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
SELECT `session_id`, `platform`, `platform_chat_id`, `kind`, `name`, `created_at`
FROM `_chat_seats` WHERE NOT `is_thread` ORDER BY `created_at`, `session_id`;
--> statement-breakpoint
UPDATE `rome_sessions` SET `chat_id` = (
  SELECT ch.`id` FROM `_chat_seats` s
  JOIN `chats` ch ON ch.`platform` = s.`platform` AND ch.`platform_chat_id` = s.`platform_chat_id`
  WHERE s.`session_id` = `rome_sessions`.`id`
) WHERE `id` IN (SELECT `session_id` FROM `_chat_seats` WHERE NOT `is_thread`);
--> statement-breakpoint
UPDATE `rome_sessions` SET
  `chat_id` = (SELECT p.`chat_id` FROM `rome_sessions` p WHERE p.`id` = `rome_sessions`.`parent_session_id`),
  `thread_id` = `source_thread_id`
WHERE `id` IN (SELECT `session_id` FROM `_chat_seats` WHERE `is_thread`);
--> statement-breakpoint
INSERT OR IGNORE INTO `chat_threads` (`chat_id`, `platform_thread_id`, `name`, `started_at`)
SELECT r.`chat_id`, r.`thread_id`, r.`source_thread_name`, r.`created_at`
FROM `rome_sessions` r WHERE r.`thread_id` IS NOT NULL AND r.`chat_id` IS NOT NULL
ORDER BY r.`created_at`;
--> statement-breakpoint
INSERT OR IGNORE INTO `chat_participants` (`chat_id`, `account_id`, `since`)
SELECT r.`chat_id`, s.`account_id`, r.`created_at`
FROM `_chat_seats` s JOIN `rome_sessions` r ON r.`id` = s.`session_id`
WHERE r.`chat_id` IS NOT NULL
UNION ALL
SELECT r.`chat_id`, 'guardian', r.`created_at`
FROM `_chat_seats` s JOIN `rome_sessions` r ON r.`id` = s.`session_id`
WHERE r.`chat_id` IS NOT NULL AND s.`platform` = 'webchat';
--> statement-breakpoint
INSERT OR IGNORE INTO `chat_messages` (`id`, `chat_id`, `thread_id`, `sender_account_id`, `sender_agent`,
  `sender_name`, `text`, `parts`, `platform_message_id`, `reply_to_platform_message_id`, `said_at`)
SELECT `legacy_id`, `chat_id`, `thread_id`, `sender_account_id`, `sender_agent`, `sender_name`, `text`,
  `parts`, `platform_message_id`, `reply_to_platform_message_id`, `said_at`
FROM `_chat_message_rows` ORDER BY `said_at`, `legacy_id`;
--> statement-breakpoint
INSERT OR IGNORE INTO `chat_message_deliveries` (`message_id`, `state`, `at`)
SELECT cm.`id`, 'sent', cm.`said_at` FROM `_chat_message_rows` v
JOIN `chat_messages` cm ON cm.`id` = v.`legacy_id` WHERE v.`from_rome`;
--> statement-breakpoint
INSERT OR IGNORE INTO `agent_turn_messages` (`message_id`, `session_id`, `turn_id`, `role`, `input_state`)
SELECT coalesce(
    (SELECT cm.`id` FROM `chat_messages` cm WHERE cm.`id` = v.`legacy_id`),
    (SELECT cm.`id` FROM `chat_messages` cm
     WHERE cm.`chat_id` = v.`chat_id` AND cm.`platform_message_id` = v.`platform_message_id`)),
  v.`session_id`, v.`link_turn_id`, v.`link_role`, v.`input_state`
FROM `_chat_message_rows` v WHERE v.`link_role` IS NOT NULL;
--> statement-breakpoint
INSERT OR IGNORE INTO `chat_message_platform_ids` (`chat_id`, `platform_message_id`, `message_id`)
SELECT r.`chat_id`, p.`platform_message_id`, cm.`id`
FROM `rome_agent_message_platform_ids` p
JOIN `rome_sessions` r ON r.`id` = p.`session_id`
JOIN `chat_messages` cm ON cm.`id` = p.`message_id`
WHERE r.`chat_id` IS NOT NULL;
--> statement-breakpoint
-- Mirror: while readers switch, every write to today's rows lands in Chats'
-- tables too, through the same views the backfill read. Dropped at the
-- contract step, when writers write Chats' tables directly.
CREATE TRIGGER `_mirror_chat_seat_insert` AFTER INSERT ON `rome_sessions`
WHEN NEW.`type` = 'channel' AND NEW.`source_channel` IS NOT NULL AND NEW.`source_thread_id` IS NOT NULL
BEGIN
  INSERT OR IGNORE INTO `chats` (`id`, `platform`, `platform_chat_id`, `kind`, `name`, `started_at`)
  SELECT `session_id`, `platform`, `platform_chat_id`, `kind`, `name`, `created_at`
  FROM `_chat_seats` WHERE `session_id` = NEW.`id` AND NOT `is_thread`;
  UPDATE `rome_sessions` SET `chat_id` = (
    SELECT ch.`id` FROM `_chat_seats` s
    JOIN `chats` ch ON ch.`platform` = s.`platform` AND ch.`platform_chat_id` = s.`platform_chat_id`
    WHERE s.`session_id` = NEW.`id`)
  WHERE `id` = NEW.`id` AND NOT (SELECT `is_thread` FROM `_chat_seats` WHERE `session_id` = NEW.`id`);
  UPDATE `rome_sessions` SET
    `chat_id` = (SELECT p.`chat_id` FROM `rome_sessions` p WHERE p.`id` = NEW.`parent_session_id`),
    `thread_id` = NEW.`source_thread_id`
  WHERE `id` = NEW.`id` AND (SELECT `is_thread` FROM `_chat_seats` WHERE `session_id` = NEW.`id`);
  INSERT OR IGNORE INTO `chat_threads` (`chat_id`, `platform_thread_id`, `name`, `started_at`)
  SELECT `chat_id`, `thread_id`, `source_thread_name`, `created_at` FROM `rome_sessions`
  WHERE `id` = NEW.`id` AND `thread_id` IS NOT NULL AND `chat_id` IS NOT NULL;
  INSERT OR IGNORE INTO `chat_participants` (`chat_id`, `account_id`, `since`)
  SELECT r.`chat_id`, s.`account_id`, r.`created_at`
  FROM `_chat_seats` s JOIN `rome_sessions` r ON r.`id` = s.`session_id`
  WHERE s.`session_id` = NEW.`id` AND r.`chat_id` IS NOT NULL
  UNION ALL
  SELECT r.`chat_id`, 'guardian', r.`created_at`
  FROM `_chat_seats` s JOIN `rome_sessions` r ON r.`id` = s.`session_id`
  WHERE s.`session_id` = NEW.`id` AND r.`chat_id` IS NOT NULL AND s.`platform` = 'webchat';
END;
--> statement-breakpoint
-- A fork promoted to a chat becomes a seat by update, not insert.
CREATE TRIGGER `_mirror_chat_seat_promote` AFTER UPDATE OF `type`, `source_channel`, `source_thread_id` ON `rome_sessions`
WHEN NEW.`chat_id` IS NULL AND NEW.`type` = 'channel' AND NEW.`source_channel` IS NOT NULL AND NEW.`source_thread_id` IS NOT NULL
BEGIN
  INSERT OR IGNORE INTO `chats` (`id`, `platform`, `platform_chat_id`, `kind`, `name`, `started_at`)
  SELECT `session_id`, `platform`, `platform_chat_id`, `kind`, `name`, `created_at`
  FROM `_chat_seats` WHERE `session_id` = NEW.`id` AND NOT `is_thread`;
  UPDATE `rome_sessions` SET `chat_id` = (
    SELECT ch.`id` FROM `_chat_seats` s
    JOIN `chats` ch ON ch.`platform` = s.`platform` AND ch.`platform_chat_id` = s.`platform_chat_id`
    WHERE s.`session_id` = NEW.`id`)
  WHERE `id` = NEW.`id` AND NOT (SELECT `is_thread` FROM `_chat_seats` WHERE `session_id` = NEW.`id`);
  UPDATE `rome_sessions` SET
    `chat_id` = (SELECT p.`chat_id` FROM `rome_sessions` p WHERE p.`id` = NEW.`parent_session_id`),
    `thread_id` = NEW.`source_thread_id`
  WHERE `id` = NEW.`id` AND (SELECT `is_thread` FROM `_chat_seats` WHERE `session_id` = NEW.`id`);
  INSERT OR IGNORE INTO `chat_threads` (`chat_id`, `platform_thread_id`, `name`, `started_at`)
  SELECT `chat_id`, `thread_id`, `source_thread_name`, `created_at` FROM `rome_sessions`
  WHERE `id` = NEW.`id` AND `thread_id` IS NOT NULL AND `chat_id` IS NOT NULL;
  INSERT OR IGNORE INTO `chat_participants` (`chat_id`, `account_id`, `since`)
  SELECT r.`chat_id`, s.`account_id`, r.`created_at`
  FROM `_chat_seats` s JOIN `rome_sessions` r ON r.`id` = s.`session_id`
  WHERE s.`session_id` = NEW.`id` AND r.`chat_id` IS NOT NULL
  UNION ALL
  SELECT r.`chat_id`, 'guardian', r.`created_at`
  FROM `_chat_seats` s JOIN `rome_sessions` r ON r.`id` = s.`session_id`
  WHERE s.`session_id` = NEW.`id` AND r.`chat_id` IS NOT NULL AND s.`platform` = 'webchat';
  INSERT OR IGNORE INTO `chat_messages` (`id`, `chat_id`, `thread_id`, `sender_account_id`, `sender_agent`,
    `sender_name`, `text`, `parts`, `platform_message_id`, `reply_to_platform_message_id`, `said_at`)
  SELECT `legacy_id`, `chat_id`, `thread_id`, `sender_account_id`, `sender_agent`, `sender_name`, `text`,
    `parts`, `platform_message_id`, `reply_to_platform_message_id`, `said_at`
  FROM `_chat_message_rows` WHERE `session_id` = NEW.`id` ORDER BY `said_at`, `legacy_id`;
  INSERT OR IGNORE INTO `chat_message_deliveries` (`message_id`, `state`, `at`)
  SELECT cm.`id`, 'sent', cm.`said_at` FROM `_chat_message_rows` v
  JOIN `chat_messages` cm ON cm.`id` = v.`legacy_id`
  WHERE v.`session_id` = NEW.`id` AND v.`from_rome`;
  INSERT OR REPLACE INTO `agent_turn_messages` (`message_id`, `session_id`, `turn_id`, `role`, `input_state`)
  SELECT v.`legacy_id`, v.`session_id`, v.`link_turn_id`, v.`link_role`, v.`input_state`
  FROM `_chat_message_rows` v
  WHERE v.`session_id` = NEW.`id` AND v.`link_role` IS NOT NULL
    AND EXISTS (SELECT 1 FROM `chat_messages` cm WHERE cm.`id` = v.`legacy_id`);
END;
--> statement-breakpoint
CREATE TRIGGER `_mirror_chat_seat_thread` AFTER UPDATE OF `parent_session_id` ON `rome_sessions`
WHEN NEW.`type` = 'channel' AND NEW.`parent_session_id` IS NOT NULL
  AND coalesce(NEW.`source_channel`, '') <> 'webchat' AND NEW.`thread_id` IS NULL
BEGIN
  UPDATE `rome_sessions` SET
    `chat_id` = (SELECT p.`chat_id` FROM `rome_sessions` p WHERE p.`id` = NEW.`parent_session_id`),
    `thread_id` = NEW.`source_thread_id`
  WHERE `id` = NEW.`id`;
END;
--> statement-breakpoint
CREATE TRIGGER `_mirror_chat_name` AFTER UPDATE OF `name`, `source_thread_name` ON `rome_sessions`
WHEN NEW.`chat_id` IS NOT NULL AND NEW.`thread_id` IS NULL
BEGIN
  UPDATE `chats` SET `name` = (SELECT `name` FROM `_chat_seats` WHERE `session_id` = NEW.`id`)
  WHERE `id` = NEW.`chat_id` AND `id` = NEW.`id`;
END;
--> statement-breakpoint
CREATE TRIGGER `_mirror_chat_seat_delete` AFTER DELETE ON `rome_sessions`
WHEN OLD.`chat_id` IS NOT NULL AND OLD.`thread_id` IS NULL
BEGIN
  DELETE FROM `chats` WHERE `id` = OLD.`chat_id` AND NOT EXISTS (
    SELECT 1 FROM `rome_sessions` WHERE `chat_id` = OLD.`chat_id` AND `thread_id` IS NULL);
END;
--> statement-breakpoint
CREATE TRIGGER `_mirror_chat_message_insert` AFTER INSERT ON `rome_agent_messages`
WHEN NEW.`role` <> 'trace'
BEGIN
  INSERT OR IGNORE INTO `chat_messages` (`id`, `chat_id`, `thread_id`, `sender_account_id`, `sender_agent`,
    `sender_name`, `text`, `parts`, `platform_message_id`, `reply_to_platform_message_id`, `said_at`)
  SELECT `legacy_id`, `chat_id`, `thread_id`, `sender_account_id`, `sender_agent`, `sender_name`, `text`,
    `parts`, `platform_message_id`, `reply_to_platform_message_id`, `said_at`
  FROM `_chat_message_rows` WHERE `legacy_id` = NEW.`id`;
  INSERT OR IGNORE INTO `chat_message_deliveries` (`message_id`, `state`, `at`)
  SELECT cm.`id`, 'sent', cm.`said_at` FROM `_chat_message_rows` v
  JOIN `chat_messages` cm ON cm.`id` = v.`legacy_id`
  WHERE v.`legacy_id` = NEW.`id` AND v.`from_rome`;
  INSERT OR REPLACE INTO `agent_turn_messages` (`message_id`, `session_id`, `turn_id`, `role`, `input_state`)
  SELECT coalesce(
      (SELECT cm.`id` FROM `chat_messages` cm WHERE cm.`id` = v.`legacy_id`),
      (SELECT cm.`id` FROM `chat_messages` cm
       WHERE cm.`chat_id` = v.`chat_id` AND cm.`platform_message_id` = v.`platform_message_id`)),
    v.`session_id`, v.`link_turn_id`, v.`link_role`, v.`input_state`
  FROM `_chat_message_rows` v WHERE v.`legacy_id` = NEW.`id` AND v.`link_role` IS NOT NULL;
END;
--> statement-breakpoint
CREATE TRIGGER `_mirror_chat_message_update` AFTER UPDATE ON `rome_agent_messages`
WHEN NEW.`role` <> 'trace'
BEGIN
  UPDATE OR IGNORE `chat_messages` SET
    (`sender_account_id`, `sender_agent`, `sender_name`, `text`, `parts`, `platform_message_id`,
     `reply_to_platform_message_id`, `said_at`) = (
      SELECT `sender_account_id`, `sender_agent`, `sender_name`, `text`, `parts`, `platform_message_id`,
        `reply_to_platform_message_id`, `said_at`
      FROM `_chat_message_rows` WHERE `legacy_id` = NEW.`id`)
  WHERE `id` = NEW.`id`;
  INSERT OR IGNORE INTO `chat_message_deliveries` (`message_id`, `state`, `at`)
  SELECT cm.`id`, 'sent', cm.`said_at` FROM `_chat_message_rows` v
  JOIN `chat_messages` cm ON cm.`id` = v.`legacy_id`
  WHERE v.`legacy_id` = NEW.`id` AND v.`from_rome`;
  DELETE FROM `chat_message_deliveries` WHERE `message_id` = NEW.`id`
    AND NOT coalesce((SELECT `from_rome` FROM `_chat_message_rows` WHERE `legacy_id` = NEW.`id`), 0);
  DELETE FROM `agent_turn_messages` WHERE `session_id` = NEW.`session_id` AND `message_id` = coalesce(
    (SELECT cm.`id` FROM `chat_messages` cm WHERE cm.`id` = NEW.`id`),
    (SELECT cm.`id` FROM `chat_messages` cm JOIN `rome_sessions` r ON r.`chat_id` = cm.`chat_id`
     WHERE r.`id` = NEW.`session_id` AND cm.`platform_message_id` = NEW.`platform_message_id`));
  INSERT OR REPLACE INTO `agent_turn_messages` (`message_id`, `session_id`, `turn_id`, `role`, `input_state`)
  SELECT coalesce(
      (SELECT cm.`id` FROM `chat_messages` cm WHERE cm.`id` = v.`legacy_id`),
      (SELECT cm.`id` FROM `chat_messages` cm
       WHERE cm.`chat_id` = v.`chat_id` AND cm.`platform_message_id` = v.`platform_message_id`)),
    v.`session_id`, v.`link_turn_id`, v.`link_role`, v.`input_state`
  FROM `_chat_message_rows` v WHERE v.`legacy_id` = NEW.`id` AND v.`link_role` IS NOT NULL;
END;
--> statement-breakpoint
CREATE TRIGGER `_mirror_chat_message_delete` AFTER DELETE ON `rome_agent_messages`
WHEN OLD.`role` <> 'trace'
BEGIN
  DELETE FROM `agent_turn_messages` WHERE `session_id` = OLD.`session_id` AND `message_id` = OLD.`id`;
  DELETE FROM `chat_messages` WHERE `id` = OLD.`id`;
END;
--> statement-breakpoint
CREATE TRIGGER `_mirror_chat_platform_id_insert` AFTER INSERT ON `rome_agent_message_platform_ids`
BEGIN
  INSERT OR IGNORE INTO `chat_message_platform_ids` (`chat_id`, `platform_message_id`, `message_id`)
  SELECT r.`chat_id`, NEW.`platform_message_id`, cm.`id`
  FROM `rome_sessions` r JOIN `chat_messages` cm ON cm.`id` = NEW.`message_id`
  WHERE r.`id` = NEW.`session_id` AND r.`chat_id` IS NOT NULL;
END;
--> statement-breakpoint
CREATE TRIGGER `_mirror_chat_platform_id_delete` AFTER DELETE ON `rome_agent_message_platform_ids`
BEGIN
  DELETE FROM `chat_message_platform_ids` WHERE `message_id` = OLD.`message_id`
    AND `platform_message_id` = OLD.`platform_message_id`;
END;
