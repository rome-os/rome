DROP INDEX `idx_rome_sessions_chat_activity`;--> statement-breakpoint
DROP INDEX `idx_rome_sessions_chat_project_activity`;--> statement-breakpoint
CREATE INDEX `idx_rome_sessions_chat_activity` ON `rome_sessions` (`activity_at`,`created_at`,`id`) WHERE ("rome_sessions"."type" = 'channel' and "rome_sessions"."chat_platform" = 'webchat');--> statement-breakpoint
CREATE INDEX `idx_rome_sessions_chat_project_activity` ON `rome_sessions` (`project_path`,`activity_at`,`created_at`,`id`) WHERE ("rome_sessions"."type" = 'channel' and "rome_sessions"."chat_platform" = 'webchat');