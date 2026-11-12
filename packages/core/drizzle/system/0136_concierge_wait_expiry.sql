ALTER TABLE `concierge_tasks` ADD `expired_wait_at` integer;--> statement-breakpoint
ALTER TABLE `concierge_tasks` ADD `no_response_unlisted` integer DEFAULT false NOT NULL;