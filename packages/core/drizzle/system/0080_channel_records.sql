CREATE TABLE `channels` (
	`id` text PRIMARY KEY NOT NULL,
	`service` text NOT NULL,
	`platform` text NOT NULL,
	`connection_id` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `channels_connection_unique` ON `channels` (`connection_id`);