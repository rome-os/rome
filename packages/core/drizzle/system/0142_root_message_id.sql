ALTER TABLE `chat_messages` ADD `root_message_id` integer;--> statement-breakpoint
CREATE INDEX `idx_chat_messages_root` ON `chat_messages` (`chat_id`,`root_message_id`);--> statement-breakpoint
-- A message in a chat thread named by another message's key takes that
-- message as its root, so today's task threads keep their grouping. Every
-- other message stays null: its own root.
UPDATE `chat_messages` SET `root_message_id` = (
  SELECT `root`.`id` FROM `chat_messages` AS `root`
  WHERE `root`.`chat_id` = `chat_messages`.`chat_id` AND `root`.`key` = `chat_messages`.`chat_thread_id`
) WHERE `chat_thread_id` IS NOT NULL AND `chat_thread_id` <> `key`;--> statement-breakpoint
DROP INDEX `idx_chat_messages_chat_thread`;--> statement-breakpoint
ALTER TABLE `chat_messages` DROP COLUMN `chat_thread_id`;--> statement-breakpoint
ALTER TABLE `chat_messages` DROP COLUMN `chat_thread_settled`;--> statement-breakpoint
ALTER TABLE `concierge_tasks` DROP COLUMN `thread_root`;
