CREATE TABLE `rome_trace_archive_deletes` (
	`session_id` text PRIMARY KEY NOT NULL
);
--> statement-breakpoint
CREATE TABLE `rome_trace_archives` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`status` text NOT NULL,
	`location` text NOT NULL,
	`bytes` integer NOT NULL,
	`sha256` text NOT NULL,
	`manifest` text,
	`block_count` integer NOT NULL,
	`message_count` integer NOT NULL,
	`created_at` integer NOT NULL,
	`stored_at` integer,
	`pruned_at` integer
);
--> statement-breakpoint
CREATE INDEX `idx_rome_trace_archives_session` ON `rome_trace_archives` (`session_id`);--> statement-breakpoint
ALTER TABLE `rome_agent_messages` ADD `trace_archive_id` text;--> statement-breakpoint
CREATE INDEX `idx_rome_agent_messages_trace_archive` ON `rome_agent_messages` (`trace_archive_id`) WHERE "rome_agent_messages"."trace_archive_id" IS NOT NULL;