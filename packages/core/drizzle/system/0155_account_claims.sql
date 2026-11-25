CREATE TABLE `account_claims` (
	`code_hash` text PRIMARY KEY NOT NULL,
	`person_id` text NOT NULL,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`used_at` integer,
	FOREIGN KEY (`person_id`) REFERENCES `identities`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_account_claims_person` ON `account_claims` (`person_id`);