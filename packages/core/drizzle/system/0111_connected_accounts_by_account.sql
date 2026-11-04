CREATE TABLE `connected_accounts_unplaced` (
	`connection_id` text PRIMARY KEY NOT NULL,
	`agent` text NOT NULL
);
--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_connected_accounts` (
	`platform` text NOT NULL,
	`account_id` text NOT NULL,
	`agent` text,
	PRIMARY KEY(`platform`, `account_id`)
);
--> statement-breakpoint
-- Each connected account moves from its connection to the account that
-- connection reaches, keeping its agent: the account its grant names, else,
-- for a grant that names none (a revoked one), the account its channel
-- record was claimed for. Where two connections reach one account, the one
-- whose grant names it wins.
INSERT OR IGNORE INTO `__new_connected_accounts` (`platform`, `account_id`, `agent`)
SELECT
	coalesce(`g`.`platform`, `ch`.`platform`),
	coalesce(`g`.`account_id`, `ch`.`platform_account_id`),
	`ca`.`agent`
FROM `connected_accounts` `ca`
LEFT JOIN `connection_grants` `g`
	ON `g`.`custody` = `ca`.`connection_id`
	AND `g`.`platform` IS NOT NULL AND `g`.`account_id` IS NOT NULL
LEFT JOIN `channels` `ch`
	ON `ch`.`connection_id` = `ca`.`connection_id`
	AND `ch`.`platform_account_id` IS NOT NULL
WHERE coalesce(`g`.`account_id`, `ch`.`platform_account_id`) IS NOT NULL
ORDER BY `g`.`account_id` IS NULL;--> statement-breakpoint
-- A link whose connection has recorded no account yet, as on an instance
-- upgrading from before grants named their account, waits here for the boot
-- pass that records it.
INSERT INTO `connected_accounts_unplaced` (`connection_id`, `agent`)
SELECT `ca`.`connection_id`, `ca`.`agent`
FROM `connected_accounts` `ca`
WHERE `ca`.`agent` IS NOT NULL
	AND NOT EXISTS (
		SELECT 1 FROM `connection_grants` `g`
		WHERE `g`.`custody` = `ca`.`connection_id`
			AND `g`.`platform` IS NOT NULL AND `g`.`account_id` IS NOT NULL
	)
	AND NOT EXISTS (
		SELECT 1 FROM `channels` `ch`
		WHERE `ch`.`connection_id` = `ca`.`connection_id`
			AND `ch`.`platform_account_id` IS NOT NULL
	);--> statement-breakpoint
DROP TABLE `connected_accounts`;--> statement-breakpoint
ALTER TABLE `__new_connected_accounts` RENAME TO `connected_accounts`;--> statement-breakpoint
PRAGMA foreign_keys=ON;