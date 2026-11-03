-- A Concierge task points back to its source message in Chats, by the
-- message's id there, cleared when the message goes. The legacy row id each
-- task held moves aside until the Chats backfill finds that row's message
-- (src/db/chats-backfill.ts); the contract migration drops it.
CREATE TABLE `__new_concierge_tasks` (
	`id` text PRIMARY KEY NOT NULL,
	`title` text NOT NULL,
	`state` text NOT NULL,
	`summary` text,
	`waiting_on` text,
	`due_at` integer,
	`rank` integer,
	`session_id` text,
	`source_message_id` integer,
	`legacy_source_message_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`completed_at` integer,
	`archived_at` integer,
	FOREIGN KEY (`session_id`) REFERENCES `rome_sessions`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`source_message_id`) REFERENCES `chat_messages`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
INSERT INTO `__new_concierge_tasks`("id", "title", "state", "summary", "waiting_on", "due_at", "rank", "session_id", "source_message_id", "legacy_source_message_id", "created_at", "updated_at", "completed_at", "archived_at") SELECT "id", "title", "state", "summary", "waiting_on", "due_at", "rank", "session_id", NULL, "source_message_id", "created_at", "updated_at", "completed_at", "archived_at" FROM `concierge_tasks`;--> statement-breakpoint
DROP TABLE `concierge_tasks`;--> statement-breakpoint
ALTER TABLE `__new_concierge_tasks` RENAME TO `concierge_tasks`;--> statement-breakpoint
CREATE UNIQUE INDEX `idx_concierge_tasks_session` ON `concierge_tasks` (`session_id`) WHERE "concierge_tasks"."session_id" is not null;