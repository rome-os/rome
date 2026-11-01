PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_channel_addresses` (
	`platform` text NOT NULL,
	`account_id` text NOT NULL,
	`chat_key` text NOT NULL,
	`thread_id` text DEFAULT '' NOT NULL,
	`address` text NOT NULL,
	PRIMARY KEY(`platform`, `account_id`, `chat_key`, `thread_id`)
);
--> statement-breakpoint
INSERT INTO `__new_channel_addresses`("platform", "account_id", "chat_key", "thread_id", "address") SELECT "platform", "account_id", "chat_key", '', "address" FROM `channel_addresses`;--> statement-breakpoint
DROP TABLE `channel_addresses`;--> statement-breakpoint
ALTER TABLE `__new_channel_addresses` RENAME TO `channel_addresses`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `idx_channel_addresses_address` ON `channel_addresses` (`platform`,`account_id`,`address`);--> statement-breakpoint
-- Every thread a seat of Rome's stands in, as its account reaches it: at the
-- thread's id, under its chat's key (the chat id less its platform).
INSERT OR IGNORE INTO `channel_addresses` (`platform`, `account_id`, `chat_key`, `thread_id`, `address`)
SELECT c.`platform`, s.`account_id`, substr(c.`id`, length(c.`platform`) + 2), s.`thread_id`, s.`thread_id`
FROM `rome_sessions` s JOIN `chats` c ON c.`id` = s.`chat_id`
WHERE s.`thread_id` IS NOT NULL AND s.`account_id` IS NOT NULL AND c.`platform` <> 'webchat';
