DROP INDEX `idx_rome_sessions_project_activity`;--> statement-breakpoint
ALTER TABLE `rome_sessions` ADD `chat_platform` text;--> statement-breakpoint
UPDATE `rome_sessions` SET `chat_platform` = (SELECT c.`platform` FROM `chats` c WHERE c.`id` = `rome_sessions`.`chat_id`) WHERE `chat_id` IS NOT NULL;--> statement-breakpoint
CREATE INDEX `idx_rome_sessions_dashboard_activity` ON `rome_sessions` (`activity_at`,`created_at`,`id`) WHERE ("rome_sessions"."type" = 'channel' and "rome_sessions"."chat_platform" = 'webchat');--> statement-breakpoint
CREATE INDEX `idx_rome_sessions_dashboard_project_activity` ON `rome_sessions` (`project_path`,`activity_at`,`created_at`,`id`) WHERE ("rome_sessions"."type" = 'channel' and "rome_sessions"."chat_platform" = 'webchat');