CREATE TABLE `usage_outbox` (
	`seq` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`type` text NOT NULL,
	`event_id` text NOT NULL,
	`payload` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_usage_outbox_event` ON `usage_outbox` (`type`,`event_id`);--> statement-breakpoint
CREATE INDEX `idx_action_executions_finished` ON `action_executions` (`finished_at`,`id`);