ALTER TABLE `chat_messages` ADD `root_message_id` integer;--> statement-breakpoint
CREATE INDEX `idx_chat_messages_root` ON `chat_messages` (`chat_id`,`root_message_id`);--> statement-breakpoint
DROP INDEX `idx_chat_messages_chat_thread`;--> statement-breakpoint
ALTER TABLE `chat_messages` DROP COLUMN `chat_thread_id`;--> statement-breakpoint
ALTER TABLE `chat_messages` DROP COLUMN `chat_thread_settled`;--> statement-breakpoint
ALTER TABLE `concierge_tasks` DROP COLUMN `thread_root`;
