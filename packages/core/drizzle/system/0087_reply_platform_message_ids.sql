-- A reply the platform shows as several messages is one message row, and a
-- quote of any of those messages should reach it. The row's own column keeps
-- one platform id; this table holds the others. New and empty, so no backfill.
CREATE TABLE `rome_agent_message_platform_ids` (
	`session_id` text NOT NULL,
	`platform_message_id` text NOT NULL,
	`message_id` text NOT NULL,
	PRIMARY KEY(`session_id`, `platform_message_id`)
);
