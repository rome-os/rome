CREATE TABLE `slack_app_changes` (
	`team_id` text NOT NULL,
	`channel_id` text NOT NULL,
	`ts` text NOT NULL,
	`changed_ts` text NOT NULL,
	`text` text,
	PRIMARY KEY(`team_id`, `channel_id`, `ts`)
);
