DROP INDEX `idx_rome_sessions_chat_activity`;--> statement-breakpoint
DROP INDEX `idx_rome_sessions_chat_project_activity`;--> statement-breakpoint
DROP INDEX `idx_rome_sessions_source_channel`;--> statement-breakpoint
DROP INDEX `idx_rome_sessions_source_thread`;--> statement-breakpoint
DROP INDEX `idx_rome_sessions_channel_address`;--> statement-breakpoint
CREATE INDEX `idx_rome_sessions_activity` ON `rome_sessions` (`activity_at`,`created_at`,`id`);--> statement-breakpoint
CREATE INDEX `idx_rome_sessions_project_activity` ON `rome_sessions` (`project_path`,`activity_at`,`created_at`,`id`);--> statement-breakpoint
CREATE INDEX `idx_rome_sessions_account` ON `rome_sessions` (`account_id`);