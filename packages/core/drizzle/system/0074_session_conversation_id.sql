ALTER TABLE `sessions` ADD `conversation_id` text;--> statement-breakpoint
CREATE INDEX `idx_sessions_conversation` ON `sessions` (`conversation_id`);