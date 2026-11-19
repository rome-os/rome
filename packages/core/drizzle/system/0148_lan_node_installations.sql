CREATE TABLE `lan_node_installations` (
	`id` text PRIMARY KEY NOT NULL,
	`guardian_id` text NOT NULL,
	`name` text NOT NULL,
	`grant_hash` text,
	`expires_at` integer,
	`verifier_hash` text,
	`redeemed_at` integer,
	`device_id` text,
	`token_hash` text,
	FOREIGN KEY (`guardian_id`) REFERENCES `guardian_auth`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `lan_node_installations_device_id_unique` ON `lan_node_installations` (`device_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `lan_node_installations_token_hash_unique` ON `lan_node_installations` (`token_hash`);