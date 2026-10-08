ALTER TABLE `routine_runs` ADD `fired_by` text;--> statement-breakpoint
CREATE INDEX `idx_routine_runs_execution_id` ON `routine_runs` (`execution_id`);