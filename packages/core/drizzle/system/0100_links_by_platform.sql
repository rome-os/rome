-- A link and a dismissal name an account the way Chats does: by the platform
-- and the platform's own id for it (docs/domains/chats.md#account). Until now
-- they named it by the kind of connection Rome met it through, so a Telegram
-- sender met by the bot and by the signed-in user was two accounts, and a Lark
-- sender sat under `feishu`.
--
-- The platform of a stored key, for every key but `feishu`: the channel record
-- that carries the key as its id, else the kind's own platform, which is what
-- platformOf in @rome/api-types/platform answers.
--
-- A `feishu` key covers both Feishu and Lark apps, and a Feishu id is issued
-- per app, so the account arrived through exactly one of Rome's accounts. Each
-- row is placed by what recorded that arrival: the newest triage record of the
-- sender on a channel Rome holds, then the account profile cache, which has
-- filed Lark senders under `lark` since it began. A row neither knows falls
-- back to the apps Rome holds now: only Lark apps place it under `lark`,
-- anything else under `feishu`.
--
-- What this cannot settle cleanly goes in `__links_migration_report`: a link
-- dropped because its account is now one another person holds, and a `feishu`
-- row placed while Rome holds both Feishu and Lark apps. Rome logs that report
-- and drops it when it starts (reportLinksMigration in src/db/migrate.ts).
CREATE TABLE `links` (
	`id` text PRIMARY KEY NOT NULL,
	`person_id` text NOT NULL,
	`platform` text NOT NULL,
	`account_id` text NOT NULL,
	`delegate` integer DEFAULT false NOT NULL,
	FOREIGN KEY (`person_id`) REFERENCES `persons`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_links_account` ON `links` (`platform`,`account_id`);
--> statement-breakpoint
CREATE TABLE `__platform_of_key` (
	`key` text NOT NULL,
	`account_id` text NOT NULL,
	`platform` text NOT NULL,
	`guessed` integer NOT NULL,
	PRIMARY KEY(`key`, `account_id`)
);
--> statement-breakpoint
INSERT OR IGNORE INTO `__platform_of_key` (`key`, `account_id`, `platform`, `guessed`)
SELECT `stored`.`key`, `stored`.`account_id`,
  CASE WHEN `stored`.`key` = 'feishu' THEN COALESCE(
    (SELECT `c`.`platform` FROM `sentinel_log` `s` JOIN `channels` `c` ON `c`.`id` = `s`.`channel`
      WHERE `s`.`channel_user_id` = `stored`.`account_id` AND `c`.`connection_kind` = 'feishu'
      ORDER BY `s`.`created_at` DESC LIMIT 1),
    (SELECT `p`.`platform` FROM `account_profiles` `p`
      WHERE `p`.`account_id` = `stored`.`account_id` AND `p`.`platform` IN ('feishu', 'lark')
      ORDER BY `p`.`updated_at` DESC LIMIT 1),
    (SELECT CASE WHEN COUNT(DISTINCT `c`.`platform`) = 1 THEN MIN(`c`.`platform`) ELSE 'feishu' END
      FROM `channels` `c` WHERE `c`.`connection_kind` = 'feishu' AND `c`.`connection_id` IS NOT NULL
      HAVING COUNT(*) > 0),
    'feishu')
  ELSE COALESCE(
    (SELECT `c`.`platform` FROM `channels` `c` WHERE `c`.`id` = `stored`.`key`),
    CASE `stored`.`key`
      WHEN 'telegram_user' THEN 'telegram'
      WHEN 'wechat_user' THEN 'wechat'
      WHEN 'slack_bot' THEN 'slack'
      ELSE `stored`.`key`
    END)
  END,
  `stored`.`key` = 'feishu'
    AND NOT EXISTS (SELECT 1 FROM `sentinel_log` `s` JOIN `channels` `c` ON `c`.`id` = `s`.`channel`
      WHERE `s`.`channel_user_id` = `stored`.`account_id` AND `c`.`connection_kind` = 'feishu')
    AND NOT EXISTS (SELECT 1 FROM `account_profiles` `p`
      WHERE `p`.`account_id` = `stored`.`account_id` AND `p`.`platform` IN ('feishu', 'lark'))
    AND (SELECT COUNT(DISTINCT `c`.`platform`) FROM `channels` `c`
      WHERE `c`.`connection_kind` = 'feishu' AND `c`.`connection_id` IS NOT NULL) > 1
FROM (
  SELECT `channel` AS `key`, `channel_user_id` AS `account_id` FROM `channel_mappings`
  UNION
  SELECT `channel`, `channel_user_id` FROM `dismissed_accounts`
) AS `stored`;
--> statement-breakpoint
-- Two rows that are now one account keep the oldest. Such a pair pointing at
-- two people is not expected in practice, and the report names any dropped.
INSERT OR IGNORE INTO `links` (`id`, `person_id`, `platform`, `account_id`, `delegate`)
SELECT `m`.`id`, `m`.`person_id`, `k`.`platform`, `m`.`channel_user_id`, `m`.`delegate`
FROM `channel_mappings` `m`
JOIN `__platform_of_key` `k` ON `k`.`key` = `m`.`channel` AND `k`.`account_id` = `m`.`channel_user_id`
ORDER BY `m`.`rowid`;
--> statement-breakpoint
CREATE TABLE `__links_migration_report` (
	`what` text NOT NULL,
	`platform` text NOT NULL,
	`account_id` text NOT NULL,
	`key` text NOT NULL,
	`person_id` text NOT NULL,
	`kept_person_id` text
);
--> statement-breakpoint
INSERT INTO `__links_migration_report` (`what`, `platform`, `account_id`, `key`, `person_id`, `kept_person_id`)
SELECT 'dropped', `k`.`platform`, `m`.`channel_user_id`, `m`.`channel`, `m`.`person_id`, `l`.`person_id`
FROM `channel_mappings` `m`
JOIN `__platform_of_key` `k` ON `k`.`key` = `m`.`channel` AND `k`.`account_id` = `m`.`channel_user_id`
JOIN `links` `l` ON `l`.`platform` = `k`.`platform` AND `l`.`account_id` = `m`.`channel_user_id`
WHERE `l`.`id` <> `m`.`id` AND `l`.`person_id` <> `m`.`person_id`;
--> statement-breakpoint
INSERT INTO `__links_migration_report` (`what`, `platform`, `account_id`, `key`, `person_id`, `kept_person_id`)
SELECT 'guessed', `k`.`platform`, `m`.`channel_user_id`, `m`.`channel`, `m`.`person_id`, NULL
FROM `channel_mappings` `m`
JOIN `__platform_of_key` `k` ON `k`.`key` = `m`.`channel` AND `k`.`account_id` = `m`.`channel_user_id`
WHERE `k`.`guessed`;
--> statement-breakpoint
CREATE TABLE `__new_dismissed_accounts` (
	`platform` text NOT NULL,
	`account_id` text NOT NULL,
	PRIMARY KEY(`platform`, `account_id`)
);
--> statement-breakpoint
-- An account is linked or dismissed, never both. Where merging made one
-- account of a linked and a dismissed key, the link stands.
INSERT OR IGNORE INTO `__new_dismissed_accounts` (`platform`, `account_id`)
SELECT `k`.`platform`, `d`.`channel_user_id`
FROM `dismissed_accounts` `d`
JOIN `__platform_of_key` `k` ON `k`.`key` = `d`.`channel` AND `k`.`account_id` = `d`.`channel_user_id`
WHERE NOT EXISTS (
  SELECT 1 FROM `links` `l` WHERE `l`.`platform` = `k`.`platform` AND `l`.`account_id` = `d`.`channel_user_id`
);
--> statement-breakpoint
DROP TABLE `dismissed_accounts`;
--> statement-breakpoint
ALTER TABLE `__new_dismissed_accounts` RENAME TO `dismissed_accounts`;
--> statement-breakpoint
DROP TABLE `channel_mappings`;
--> statement-breakpoint
DROP TABLE `__platform_of_key`;
