CREATE TABLE `account_profiles` (
	`platform` text NOT NULL,
	`account_id` text NOT NULL,
	`display_name` text,
	`handle` text,
	`avatar_url` text,
	`source` text NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`platform`, `account_id`)
);
