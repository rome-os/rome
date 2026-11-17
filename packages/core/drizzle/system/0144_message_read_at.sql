ALTER TABLE `chat_messages` ADD `read_at` integer;--> statement-breakpoint
UPDATE `chat_messages` SET `read_at` = `said_at`;--> statement-breakpoint
UPDATE `chat_messages` SET `root_message_id` = NULL;
