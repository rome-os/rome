DROP TABLE `concierge_message_tasks`;--> statement-breakpoint
ALTER TABLE `chat_messages` ADD `reaction` text;--> statement-breakpoint
ALTER TABLE `concierge_message_turns` DROP COLUMN `turn_failed`;