CREATE TABLE `manager__config` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `manager__facts` (
	`seq` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`id` text NOT NULL,
	`task_id` text NOT NULL,
	`kind` text NOT NULL,
	`by` text NOT NULL,
	`source` text,
	`payload` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `manager__facts_task_idx` ON `manager__facts` (`task_id`);--> statement-breakpoint
CREATE INDEX `manager__facts_id_idx` ON `manager__facts` (`id`);--> statement-breakpoint
CREATE TABLE `manager__locks` (
	`name` text PRIMARY KEY NOT NULL,
	`held_until` integer NOT NULL
);
