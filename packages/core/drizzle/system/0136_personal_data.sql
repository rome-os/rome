CREATE TABLE `personal_data_ingests` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`source` text NOT NULL,
	`origin` text NOT NULL,
	`batch_id` text,
	`trigger` text,
	`received_at` integer NOT NULL,
	`item_count` integer DEFAULT 0 NOT NULL,
	`inserted` integer DEFAULT 0 NOT NULL,
	`updated` integer DEFAULT 0 NOT NULL,
	`unchanged` integer DEFAULT 0 NOT NULL,
	`deleted` integer DEFAULT 0 NOT NULL,
	`rejected` integer DEFAULT 0 NOT NULL,
	`range_start_at` integer,
	`range_end_at` integer,
	`duration_ms` integer,
	`status` text NOT NULL,
	`error_code` text,
	`response` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_personal_data_ingests_batch` ON `personal_data_ingests` (`source`,`origin`,`batch_id`);--> statement-breakpoint
CREATE INDEX `idx_personal_data_ingests_received` ON `personal_data_ingests` (`source`,`received_at`);--> statement-breakpoint
CREATE TABLE `personal_data_points` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`source` text NOT NULL,
	`origin` text NOT NULL,
	`type` text NOT NULL,
	`shape` text NOT NULL,
	`resolution` text,
	`start_at` integer NOT NULL,
	`end_at` integer NOT NULL,
	`tz` text NOT NULL,
	`value` real,
	`unit` text,
	`fields` text,
	`metadata` text,
	`dedupe_key` text NOT NULL,
	`content_hash` text NOT NULL,
	`ingest_id` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_personal_data_points_key` ON `personal_data_points` (`source`,`origin`,`dedupe_key`);--> statement-breakpoint
CREATE INDEX `idx_personal_data_points_query` ON `personal_data_points` (`source`,`type`,`resolution`,`start_at`);--> statement-breakpoint
CREATE TABLE `personal_data_sources` (
	`source` text NOT NULL,
	`origin` text NOT NULL,
	`origin_name` text,
	`platform` text,
	`app_version` text,
	`state` text NOT NULL,
	`first_sync_at` integer,
	`last_sync_at` integer,
	`last_result` text,
	`last_error_code` text,
	`note` text,
	PRIMARY KEY(`source`, `origin`)
);
--> statement-breakpoint
CREATE TABLE `personal_data_types` (
	`source` text NOT NULL,
	`origin` text NOT NULL,
	`type` text NOT NULL,
	`shape` text NOT NULL,
	`unit` text,
	`resolutions` text NOT NULL,
	`earliest_at` integer,
	`latest_at` integer,
	`synced_through_at` integer,
	`point_count` integer DEFAULT 0 NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`source`, `origin`, `type`)
);
