ALTER TABLE `rome_agent_messages` ADD `actor` text;--> statement-breakpoint
ALTER TABLE `rome_sessions` ADD `owner_key` text;--> statement-breakpoint
CREATE INDEX `idx_rome_sessions_owner_key` ON `rome_sessions` (`owner_key`);