CREATE TABLE `concierge_task_reactions` (
	`task_id` text NOT NULL,
	`chat_id` text NOT NULL,
	`message_key` text NOT NULL,
	`state` text NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`task_id`, `chat_id`, `message_key`),
	FOREIGN KEY (`task_id`) REFERENCES `concierge_tasks`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_concierge_task_reactions_message` ON `concierge_task_reactions` (`chat_id`,`message_key`);