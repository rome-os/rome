ALTER TABLE `rome_sessions` ADD `participants` text;--> statement-breakpoint
CREATE INDEX `idx_rome_sessions_chat_id` ON `rome_sessions` (`source_thread_id`,`parent_session_id`);