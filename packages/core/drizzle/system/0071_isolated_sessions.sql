ALTER TABLE `action_executions` ADD `session_id` text;--> statement-breakpoint
CREATE INDEX `idx_action_executions_session_id` ON `action_executions` (`session_id`);--> statement-breakpoint
ALTER TABLE `rome_sessions` ADD `metadata_json` text DEFAULT '{}' NOT NULL;