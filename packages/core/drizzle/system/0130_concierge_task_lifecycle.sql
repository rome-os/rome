ALTER TABLE `concierge_tasks` ADD `archived_with_chat` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `concierge_tasks` ADD `linked_at` integer;--> statement-breakpoint
ALTER TABLE `concierge_tasks` ADD `stopped_at` integer;--> statement-breakpoint
ALTER TABLE `concierge_tasks` ADD `stop_reason` text;--> statement-breakpoint
ALTER TABLE `concierge_tasks` ADD `last_outcome` text;
--> statement-breakpoint
-- A row that links a task chat now has linked it, so it never links another.
UPDATE `concierge_tasks` SET `linked_at` = `created_at` WHERE `session_id` IS NOT NULL;