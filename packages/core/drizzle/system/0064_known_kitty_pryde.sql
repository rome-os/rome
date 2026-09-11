ALTER TABLE `linkedin_participants` ADD `profile_url` text;--> statement-breakpoint
ALTER TABLE `linkedin_participants` ADD `last_successful_sync_at` integer;--> statement-breakpoint
ALTER TABLE `linkedin_participants` ADD `profile_sync_failure_count` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `linkedin_participants` ADD `profile_sync_retry_at` integer;