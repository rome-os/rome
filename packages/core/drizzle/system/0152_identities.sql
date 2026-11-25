CREATE TABLE `identities` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text,
	`avatar_url` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `identity_accounts` (
	`platform` text NOT NULL,
	`account_id` text NOT NULL,
	`identity_id` text NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`platform`, `account_id`),
	FOREIGN KEY (`identity_id`) REFERENCES `identities`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_identity_accounts_identity` ON `identity_accounts` (`identity_id`);