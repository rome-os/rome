CREATE TABLE `concierge_observations` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_key` text DEFAULT 'guardian' NOT NULL,
	`topic_key` text NOT NULL,
	`kind` text NOT NULL,
	`source` text NOT NULL,
	`basis` text NOT NULL,
	`confidence` real NOT NULL,
	`status` text NOT NULL,
	`summary` text NOT NULL,
	`task_id` text,
	`due_at` integer,
	`expires_at` integer NOT NULL,
	`outcomes` text DEFAULT '[]' NOT NULL,
	`told_count` integer DEFAULT 0 NOT NULL,
	`ignored_count` integer DEFAULT 0 NOT NULL,
	`last_told_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_concierge_observations_owner_topic` ON `concierge_observations` (`owner_key`,`topic_key`);--> statement-breakpoint
CREATE TABLE `concierge_told` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_key` text DEFAULT 'guardian' NOT NULL,
	`kind` text NOT NULL,
	`chat_id` text NOT NULL,
	`messages` integer NOT NULL,
	`items` text DEFAULT '[]' NOT NULL,
	`told_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_concierge_told_owner_at` ON `concierge_told` (`owner_key`,`told_at`);