ALTER TABLE `chat_messages` ADD `chat_thread_id` text;--> statement-breakpoint
ALTER TABLE `chat_messages` ADD `chat_thread_chosen` integer DEFAULT false NOT NULL;--> statement-breakpoint
CREATE INDEX `idx_chat_messages_chat_thread` ON `chat_messages` (`chat_id`,`chat_thread_id`);