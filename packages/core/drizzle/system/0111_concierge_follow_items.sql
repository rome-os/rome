-- Events the Concierge's triage kept from what it follows, owed to the
-- Concierge and to the digest until offered and digested
-- (src/concierge/following.ts).
CREATE TABLE `concierge_follow_items` (
	`id` text PRIMARY KEY NOT NULL,
	`event_id` text NOT NULL,
	`source` text NOT NULL,
	`kind` text NOT NULL,
	`target` text NOT NULL,
	`decision` text NOT NULL,
	`reason` text NOT NULL,
	`line` text NOT NULL,
	`url` text,
	`created_at` integer NOT NULL,
	`offered_at` integer,
	`digested_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_concierge_follow_items_event` ON `concierge_follow_items` (`event_id`);--> statement-breakpoint
CREATE INDEX `idx_concierge_follow_items_digest` ON `concierge_follow_items` (`digested_at`);