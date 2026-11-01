CREATE TABLE `channel_threads` (
	`platform` text NOT NULL,
	`account_id` text NOT NULL,
	`address` text NOT NULL,
	`chat_key` text NOT NULL,
	PRIMARY KEY(`platform`, `account_id`, `address`)
);
--> statement-breakpoint
-- Every thread a seat of Rome's stands in, as its account reaches it: the
-- thread's address and its chat's key (the chat id less its platform).
INSERT OR IGNORE INTO `channel_threads` (`platform`, `account_id`, `address`, `chat_key`)
SELECT c.`platform`, s.`account_id`, s.`thread_id`, substr(c.`id`, length(c.`platform`) + 2)
FROM `rome_sessions` s JOIN `chats` c ON c.`id` = s.`chat_id`
WHERE s.`thread_id` IS NOT NULL AND s.`account_id` IS NOT NULL AND c.`platform` <> 'webchat';
