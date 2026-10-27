-- Undoes 0101: an outbox row names the channel it went out on and its
-- recipient's address on it again, and a triage record drops the sender's
-- platform. The outbox is being redesigned around chats, and the code returns
-- to what it read before 0101 meanwhile. A database that never ran 0101 runs
-- both, and ends where it started.
--
-- A row keeps the channel it went out on as both `channel` and
-- `from_channel`, which is how the code reads a row's account and sender.
CREATE TABLE `__new_outbound_messages` (
	`id` text PRIMARY KEY NOT NULL,
	`channel` text NOT NULL,
	`channel_user_id` text NOT NULL,
	`chat_id` text NOT NULL,
	`text` text NOT NULL,
	`state` text NOT NULL,
	`provider_message_id` text,
	`error` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`from_channel` text
);
--> statement-breakpoint
INSERT INTO `__new_outbound_messages` (`id`, `channel`, `channel_user_id`, `chat_id`, `text`,
  `state`, `provider_message_id`, `error`, `created_at`, `updated_at`, `from_channel`)
SELECT `id`, `channel`, `account_id`, `chat_id`, `text`, `state`, `provider_message_id`, `error`,
  `created_at`, `updated_at`, `channel`
FROM `outbound_messages`;
--> statement-breakpoint
DROP TABLE `outbound_messages`;
--> statement-breakpoint
ALTER TABLE `__new_outbound_messages` RENAME TO `outbound_messages`;
--> statement-breakpoint
CREATE INDEX `idx_outbound_account` ON `outbound_messages` (`channel`,`channel_user_id`);
--> statement-breakpoint
-- A receipt names Rome's sending account as an object since 0101. The code
-- reads `from` as a channel name again, so it becomes the channel that
-- records that account, or null when none does. `channel` holds the
-- recipient's platform, which the code reads as a channel named after it.
UPDATE `outbound_send_receipts`
SET `response` = json_set(`response`, '$.from',
  (SELECT `c`.`id` FROM `channels` `c`
    WHERE `c`.`platform` = json_extract(`response`, '$.from.platform')
      AND `c`.`platform_account_id` = json_extract(`response`, '$.from.id')
    ORDER BY `c`.`created_at` LIMIT 1))
WHERE json_type(`response`, '$.from') = 'object';
--> statement-breakpoint
CREATE TABLE `__new_sentinel_log` (
	`id` text PRIMARY KEY NOT NULL,
	`message_id` text NOT NULL,
	`channel` text NOT NULL,
	`channel_user_id` text NOT NULL,
	`display_name` text,
	`thread_id` text,
	`text` text,
	`action` text NOT NULL,
	`response` text,
	`reviewed` integer DEFAULT false,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
INSERT INTO `__new_sentinel_log` (`id`, `message_id`, `channel`, `channel_user_id`,
  `display_name`, `thread_id`, `text`, `action`, `response`, `reviewed`, `created_at`)
SELECT `id`, `message_id`, `channel`, `channel_user_id`, `display_name`, `thread_id`, `text`,
  `action`, `response`, `reviewed`, `created_at`
FROM `sentinel_log`;
--> statement-breakpoint
DROP TABLE `sentinel_log`;
--> statement-breakpoint
ALTER TABLE `__new_sentinel_log` RENAME TO `sentinel_log`;
