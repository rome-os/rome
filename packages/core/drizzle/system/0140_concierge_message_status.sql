CREATE TABLE `concierge_message_tasks` (
	`task_id` text NOT NULL,
	`chat_id` text NOT NULL,
	`message_key` text NOT NULL,
	`seq` integer DEFAULT 0 NOT NULL,
	`ended_as` text,
	PRIMARY KEY(`task_id`, `chat_id`, `message_key`),
	FOREIGN KEY (`task_id`) REFERENCES `concierge_tasks`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_concierge_message_tasks_message` ON `concierge_message_tasks` (`chat_id`,`message_key`);--> statement-breakpoint
ALTER TABLE `concierge_message_turns` ADD `working_at` integer;--> statement-breakpoint
ALTER TABLE `concierge_message_turns` ADD `turn_failed` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `concierge_message_turns` ADD `reacted` integer DEFAULT false NOT NULL;--> statement-breakpoint
UPDATE `chat_messages` SET `reaction` = NULL WHERE `reaction` = '👀';