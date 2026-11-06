-- Each person's Concierge keeps what triage kept for them (rome-os/rome#1478):
-- an event followed by two people is kept, and told, once for each. Every
-- existing item is the guardian's.
DROP INDEX `idx_concierge_follow_items_event`;--> statement-breakpoint
ALTER TABLE `concierge_follow_items` ADD `owner_key` text DEFAULT 'guardian' NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `idx_concierge_follow_items_owner_event` ON `concierge_follow_items` (`owner_key`,`event_id`);
