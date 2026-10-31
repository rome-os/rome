CREATE TABLE `channel_addresses` (
	`platform` text NOT NULL,
	`account_id` text NOT NULL,
	`chat_key` text NOT NULL,
	`address` text NOT NULL,
	PRIMARY KEY(`platform`, `account_id`, `chat_key`)
);
--> statement-breakpoint
CREATE INDEX `idx_channel_addresses_address` ON `channel_addresses` (`platform`,`account_id`,`address`);--> statement-breakpoint
-- Where each of Rome's accounts heard a direct message, from the seat it opened
-- there, so a send into it goes where it was heard. The key is the chat's id
-- without its platform prefix.
INSERT OR IGNORE INTO `channel_addresses` (`platform`, `account_id`, `chat_key`, `address`)
SELECT c.`platform`, s.`account_id`, substr(c.`id`, length(c.`platform`) + 2), s.`source_thread_id`
FROM `rome_sessions` s
JOIN `chats` c ON c.`id` = s.`chat_id`
WHERE c.`kind` = 'dm' AND c.`platform` <> 'webchat'
  AND s.`thread_id` IS NULL AND s.`account_id` IS NOT NULL AND s.`source_thread_id` IS NOT NULL
  AND c.`id` LIKE c.`platform` || ':%'
ORDER BY s.`created_at`;
