CREATE TABLE `origin_routes` (
	`ref_hash` text PRIMARY KEY NOT NULL,
	`app_id` text NOT NULL,
	`connection_id` text NOT NULL,
	`service` text NOT NULL,
	`conversation_id` text NOT NULL,
	`status` text NOT NULL,
	`expires_at` integer NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_origin_routes_expiry` ON `origin_routes` (`expires_at`);--> statement-breakpoint
CREATE TABLE `origin_send_attempts` (
	`app_id` text NOT NULL,
	`ref_hash` text NOT NULL,
	`idempotency_key` text NOT NULL,
	`payload_hash` text NOT NULL,
	`outcome` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`app_id`, `ref_hash`, `idempotency_key`)
);
--> statement-breakpoint
CREATE INDEX `idx_origin_send_attempts_updated_at` ON `origin_send_attempts` (`updated_at`);