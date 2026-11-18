ALTER TABLE `personal_data_points` ADD `snapshot_id` text;--> statement-breakpoint
ALTER TABLE `personal_data_types` ADD `snapshot_id` text;--> statement-breakpoint
ALTER TABLE `personal_data_types` ADD `snapshot_start_at` integer;--> statement-breakpoint
ALTER TABLE `personal_data_types` ADD `snapshot_end_at` integer;--> statement-breakpoint
ALTER TABLE `personal_data_types` ADD `snapshot_read_at` integer;--> statement-breakpoint
ALTER TABLE `personal_data_types` ADD `snapshot_seen_id` text;--> statement-breakpoint
ALTER TABLE `personal_data_types` ADD `snapshot_seen_read_at` integer;