CREATE TABLE `account_claims` (
	`token_hash` text PRIMARY KEY NOT NULL,
	`platform` text NOT NULL,
	`account_id` text NOT NULL,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`confirmed_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_account_claims_account` ON `account_claims` (`platform`,`account_id`);