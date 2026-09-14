CREATE TABLE `outbound_send_receipts` (
	`id` text PRIMARY KEY NOT NULL,
	`response` text NOT NULL,
	`expires_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_outbound_send_receipts_expiry` ON `outbound_send_receipts` (`expires_at`);