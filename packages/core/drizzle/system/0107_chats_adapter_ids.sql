-- Every id Chats stores is its adapter's (docs/domains/chats.md#chat). A
-- platform's adapter passes the platform's ids through behind its platform:
-- a chat is `<platform>:<chat key>` and a message `<chat id>/<platform
-- message id>`, so a redelivery, or the same group message heard on two of
-- Rome's accounts, finds its id already on record. The dashboard is its own
-- adapter and keeps the ids it gave. Rows recorded before move to their
-- adapter's ids here, with everything that points at them, and the platform id
-- columns go.
DROP INDEX `uq_chat_messages_platform`;--> statement-breakpoint
DROP INDEX `uq_chats_platform_chat`;--> statement-breakpoint
ALTER TABLE `chat_messages` ADD `reply_to_message_id` text;--> statement-breakpoint
CREATE TABLE `_chat_ids` (`old` text PRIMARY KEY NOT NULL, `new` text NOT NULL);--> statement-breakpoint
INSERT INTO `_chat_ids` (`old`, `new`)
SELECT `id`, `platform` || ':' || `platform_chat_id` FROM `chats` WHERE `platform` <> 'webchat';--> statement-breakpoint
CREATE TABLE `_message_ids` (`old` text PRIMARY KEY NOT NULL, `new` text NOT NULL);--> statement-breakpoint
INSERT INTO `_message_ids` (`old`, `new`)
SELECT m.`id`, c.`new` || '/' || m.`platform_message_id`
FROM `chat_messages` m JOIN `_chat_ids` c ON c.`old` = m.`chat_id`;--> statement-breakpoint
INSERT INTO `chats` (`id`, `platform`, `platform_chat_id`, `kind`, `name`, `started_at`)
SELECT c.`new`, ch.`platform`, ch.`platform_chat_id`, ch.`kind`, ch.`name`, ch.`started_at`
FROM `chats` ch JOIN `_chat_ids` c ON c.`old` = ch.`id`;--> statement-breakpoint
-- Copied in rowid order, which keeps the order of lines said in one second.
INSERT INTO `chat_messages` (`id`, `chat_id`, `thread_id`, `sender_account_id`, `sender_agent`,
  `sender_name`, `text`, `parts`, `platform_message_id`, `reply_to_message_id`, `said_at`)
SELECT i.`new`, c.`new`, m.`thread_id`, m.`sender_account_id`, m.`sender_agent`, m.`sender_name`,
  m.`text`, m.`parts`, i.`new`,
  CASE WHEN m.`reply_to_platform_message_id` IS NOT NULL
       THEN c.`new` || '/' || m.`reply_to_platform_message_id` END,
  m.`said_at`
FROM `chat_messages` m
JOIN `_chat_ids` c ON c.`old` = m.`chat_id`
JOIN `_message_ids` i ON i.`old` = m.`id`
ORDER BY m.`rowid`;--> statement-breakpoint
INSERT INTO `agent_turn_messages` (`message_id`, `session_id`, `turn_id`, `role`, `input_state`)
SELECT i.`new`, l.`session_id`, l.`turn_id`, l.`role`, l.`input_state`
FROM `agent_turn_messages` l JOIN `_message_ids` i ON i.`old` = l.`message_id`;--> statement-breakpoint
UPDATE `rome_sessions` SET `chat_id` = (SELECT c.`new` FROM `_chat_ids` c WHERE c.`old` = `rome_sessions`.`chat_id`)
WHERE `chat_id` IN (SELECT `old` FROM `_chat_ids`);--> statement-breakpoint
UPDATE `concierge_tasks` SET `source_message_id` = (
  SELECT i.`new` FROM `_message_ids` i WHERE i.`old` = `concierge_tasks`.`source_message_id`)
WHERE `source_message_id` IN (SELECT `old` FROM `_message_ids`);--> statement-breakpoint
-- The old chats go, and their messages and turn links with them.
DELETE FROM `chats` WHERE `id` IN (SELECT `old` FROM `_chat_ids`);--> statement-breakpoint
-- A dashboard line quotes by the line's own id.
UPDATE `chat_messages` SET `reply_to_message_id` = `reply_to_platform_message_id`
WHERE `reply_to_platform_message_id` IS NOT NULL AND `reply_to_message_id` IS NULL;--> statement-breakpoint
DROP TABLE `_message_ids`;--> statement-breakpoint
DROP TABLE `_chat_ids`;--> statement-breakpoint
ALTER TABLE `chat_messages` DROP COLUMN `platform_message_id`;--> statement-breakpoint
ALTER TABLE `chat_messages` DROP COLUMN `reply_to_platform_message_id`;--> statement-breakpoint
ALTER TABLE `chats` DROP COLUMN `platform_chat_id`;
