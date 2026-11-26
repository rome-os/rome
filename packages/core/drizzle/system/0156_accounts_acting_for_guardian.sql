CREATE TABLE `accounts_acting_for_guardian` (
	`platform` text NOT NULL,
	`account_id` text NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`platform`, `account_id`)
);
