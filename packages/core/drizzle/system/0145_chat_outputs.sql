CREATE TABLE `chat_output_backfills` (
	`session_id` text PRIMARY KEY NOT NULL,
	`backfilled_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `chat_outputs` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`turn_id` text,
	`message_id` text,
	`source_key` text NOT NULL,
	`kind` text NOT NULL,
	`path` text NOT NULL,
	`source_path` text,
	`name` text NOT NULL,
	`mime_type` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_chat_outputs_source` ON `chat_outputs` (`session_id`,`source_key`);--> statement-breakpoint
CREATE INDEX `idx_chat_outputs_session_created` ON `chat_outputs` (`session_id`,`created_at`);