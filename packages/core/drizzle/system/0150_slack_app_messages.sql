CREATE TABLE `slack_app_messages` (
	`team_id` text NOT NULL,
	`event_id` text NOT NULL,
	`channel_id` text NOT NULL,
	`ts` text NOT NULL,
	`thread_ts` text,
	`user_id` text NOT NULL,
	`text` text NOT NULL,
	`said_at` integer NOT NULL,
	`message` text NOT NULL,
	`received_at` integer NOT NULL,
	`handed_over_at` integer,
	PRIMARY KEY(`team_id`, `event_id`)
);
--> statement-breakpoint
CREATE INDEX `idx_slack_app_messages_chat_said` ON `slack_app_messages` (`team_id`,`channel_id`,`said_at`);--> statement-breakpoint
CREATE INDEX `idx_slack_app_messages_unhanded` ON `slack_app_messages` (`team_id`,`handed_over_at`);