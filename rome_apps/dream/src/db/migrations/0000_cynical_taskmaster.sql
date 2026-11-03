CREATE TABLE `dream__run_changes` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`seq` integer NOT NULL,
	`op` text NOT NULL,
	`path` text NOT NULL,
	`content` text NOT NULL,
	`previous` text,
	`truncated` integer DEFAULT false NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `dream__run_changes_run_idx` ON `dream__run_changes` (`run_id`,`seq`);--> statement-breakpoint
CREATE TABLE `dream__runs` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`status` text NOT NULL,
	`window_hours` integer,
	`reviewed_session_id` text,
	`reviewed_session_name` text,
	`summary` text,
	`error` text,
	`started_at` integer NOT NULL,
	`finished_at` integer
);
--> statement-breakpoint
CREATE INDEX `dream__runs_started_idx` ON `dream__runs` (`started_at`);