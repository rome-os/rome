-- An outbox row names the account it is for, and Rome's account it went out
-- from, the way Chats names an account: by the platform and the platform's own
-- id for it (docs/domains/chats.md#account). Until now a row named the channel
-- it was addressed on and the channel it went out from, and every read turned
-- those into accounts. A triage record gains its sender's platform the same
-- way, and keeps the channel it names.
--
-- A stored channel name is read as People read it (platformOfChannel in
-- src/db/repositories/channel-records.ts): the platform of the channel record
-- with that id, else the platform of the connection kind it is named after,
-- which is what platformOf in @rome/api-types/platform answers. Rome's account
-- on a channel is the account its record knows, and none when it knows none.
CREATE TABLE `__channel_account` (
	`name` text PRIMARY KEY NOT NULL,
	`platform` text NOT NULL,
	`account_id` text
);
--> statement-breakpoint
INSERT INTO `__channel_account` (`name`, `platform`, `account_id`)
SELECT `named`.`name`,
  COALESCE(
    (SELECT `c`.`platform` FROM `channels` `c` WHERE `c`.`id` = `named`.`name`),
    CASE `named`.`name`
      WHEN 'telegram_user' THEN 'telegram'
      WHEN 'wechat_user' THEN 'wechat'
      WHEN 'slack_bot' THEN 'slack'
      ELSE `named`.`name`
    END),
  (SELECT `c`.`platform_account_id` FROM `channels` `c` WHERE `c`.`id` = `named`.`name`)
FROM (
  SELECT `channel` AS `name` FROM `outbound_messages`
  UNION SELECT `from_channel` FROM `outbound_messages` WHERE `from_channel` IS NOT NULL
  UNION SELECT json_extract(`response`, '$.channel') FROM `outbound_send_receipts`
  UNION SELECT json_extract(`response`, '$.from') FROM `outbound_send_receipts`
    WHERE json_type(`response`, '$.from') = 'text'
  UNION SELECT `channel` FROM `sentinel_log`
) AS `named`
WHERE `named`.`name` IS NOT NULL;
--> statement-breakpoint
-- A row went out from `from_channel`, or from the channel it names when it was
-- written before that was recorded. The account it is for is on that channel's
-- platform, which is how People read it until now. Its sender is the account
-- that channel's record knows; a channel that knows none leaves it null, and
-- such a row retries only from that same channel while it still knows none.
-- The channel stays on the row, since Rome's transcript of the send is stored
-- under it whatever the channel later learns or forgets about its account.
CREATE TABLE `__new_outbound_messages` (
	`id` text PRIMARY KEY NOT NULL,
	`platform` text NOT NULL,
	`account_id` text NOT NULL,
	`channel` text NOT NULL,
	`chat_id` text NOT NULL,
	`text` text NOT NULL,
	`state` text NOT NULL,
	`provider_message_id` text,
	`error` text,
	`from_platform` text,
	`from_account_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
INSERT INTO `__new_outbound_messages` (`id`, `platform`, `account_id`, `channel`, `chat_id`, `text`, `state`,
  `provider_message_id`, `error`, `from_platform`, `from_account_id`, `created_at`, `updated_at`)
SELECT `o`.`id`, `s`.`platform`, `o`.`channel_user_id`, `s`.`name`, `o`.`chat_id`, `o`.`text`, `o`.`state`,
  `o`.`provider_message_id`, `o`.`error`,
  CASE WHEN `s`.`account_id` IS NULL THEN NULL ELSE `s`.`platform` END,
  `s`.`account_id`, `o`.`created_at`, `o`.`updated_at`
FROM `outbound_messages` `o`
JOIN `__channel_account` `s` ON `s`.`name` = COALESCE(`o`.`from_channel`, `o`.`channel`);
--> statement-breakpoint
DROP TABLE `outbound_messages`;
--> statement-breakpoint
ALTER TABLE `__new_outbound_messages` RENAME TO `outbound_messages`;
--> statement-breakpoint
CREATE INDEX `idx_outbound_account` ON `outbound_messages` (`platform`,`account_id`);
--> statement-breakpoint
-- A receipt keeps the send as the wire answered it, which until now still
-- named channels. It is rewritten to what the wire answered: the account's
-- platform as `channel`, and Rome's account as `from`. A receipt written
-- before sends recorded `from` carries none, and still carries none.
UPDATE `outbound_send_receipts`
SET `response` = CASE
  WHEN json_type(`response`, '$.from') IS NULL THEN json_set(`response`, '$.channel',
    (SELECT `platform` FROM `__channel_account` WHERE `name` = json_extract(`response`, '$.channel')))
  WHEN json_type(`response`, '$.from') = 'text' THEN json_set(`response`,
    '$.channel',
    (SELECT `platform` FROM `__channel_account` WHERE `name` = json_extract(`response`, '$.from')),
    '$.from',
    (SELECT CASE WHEN `account_id` IS NULL THEN NULL
        ELSE json_object('platform', `platform`, 'id', `account_id`) END
      FROM `__channel_account` WHERE `name` = json_extract(`response`, '$.from')))
  ELSE json_set(`response`, '$.channel',
    (SELECT `platform` FROM `__channel_account` WHERE `name` = json_extract(`response`, '$.channel')))
END;
--> statement-breakpoint
CREATE TABLE `__new_sentinel_log` (
	`id` text PRIMARY KEY NOT NULL,
	`message_id` text NOT NULL,
	`channel` text NOT NULL,
	`platform` text NOT NULL,
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
INSERT INTO `__new_sentinel_log` (`id`, `message_id`, `channel`, `platform`, `channel_user_id`,
  `display_name`, `thread_id`, `text`, `action`, `response`, `reviewed`, `created_at`)
SELECT `l`.`id`, `l`.`message_id`, `l`.`channel`, `s`.`platform`, `l`.`channel_user_id`,
  `l`.`display_name`, `l`.`thread_id`, `l`.`text`, `l`.`action`, `l`.`response`, `l`.`reviewed`,
  `l`.`created_at`
FROM `sentinel_log` `l`
JOIN `__channel_account` `s` ON `s`.`name` = `l`.`channel`;
--> statement-breakpoint
DROP TABLE `sentinel_log`;
--> statement-breakpoint
ALTER TABLE `__new_sentinel_log` RENAME TO `sentinel_log`;
--> statement-breakpoint
DROP TABLE `__channel_account`;
