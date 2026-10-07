ALTER TABLE `connector__emitted_events` ADD `published_at` integer;--> statement-breakpoint
ALTER TABLE `connector__emitted_events` ADD `publish_claimed_at` integer;--> statement-breakpoint
ALTER TABLE `connector__emitted_events` ADD `publish_attempts` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
-- Rows stored before the outbox already had their one publish attempt.
-- Mark them published so the first drain does not re-fire old events.
UPDATE `connector__emitted_events` SET `published_at` = `received_at`;
