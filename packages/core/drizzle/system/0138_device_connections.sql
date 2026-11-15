CREATE TABLE `device_connections` (
	`device_id` text NOT NULL,
	`capability` text NOT NULL,
	`device_name` text,
	`platform` text,
	`title` text NOT NULL,
	`prefix` text NOT NULL,
	`personal` integer NOT NULL,
	`operations` text NOT NULL,
	`permission` text NOT NULL,
	`live` integer NOT NULL,
	`last_seen_at` integer NOT NULL,
	PRIMARY KEY(`device_id`, `capability`)
);
--> statement-breakpoint
ALTER TABLE `personal_data_sources` ADD `connection_id` text;