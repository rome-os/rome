CREATE TABLE `dismissed_accounts` (
	`channel` text NOT NULL,
	`channel_user_id` text NOT NULL,
	`display_name` text,
	PRIMARY KEY(`channel`, `channel_user_id`)
);
--> statement-breakpoint
-- Every link onto the stranger sentinel was a dismissal. It becomes a
-- dismissal record for the same account, keeping the channel's name for it.
INSERT OR IGNORE INTO `dismissed_accounts` (`channel`, `channel_user_id`, `display_name`)
SELECT `channel`, `channel_user_id`, `display_name` FROM `channel_mappings`
WHERE `person_id` = '__STRANGER__';--> statement-breakpoint
DELETE FROM `channel_mappings` WHERE `person_id` = '__STRANGER__';--> statement-breakpoint
-- The sentinel was structure, not someone the guardian knows. With no link
-- left on it, it goes.
DELETE FROM `persons` WHERE `id` = '__STRANGER__';
