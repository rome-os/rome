CREATE TABLE `slack_app_timeline` (
	`team_id` text NOT NULL,
	`channel_id` text NOT NULL,
	`ts` text NOT NULL,
	`prev_ts` text,
	`said_at` integer NOT NULL,
	`message` text NOT NULL,
	PRIMARY KEY(`team_id`, `channel_id`, `ts`)
);
