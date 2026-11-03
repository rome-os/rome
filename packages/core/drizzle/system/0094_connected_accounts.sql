CREATE TABLE `connected_accounts` (
	`connection_id` text PRIMARY KEY NOT NULL,
	`agent` text,
	FOREIGN KEY (`connection_id`) REFERENCES `connections`(`id`) ON UPDATE no action ON DELETE cascade
);--> statement-breakpoint
-- Every channel a live connection backs becomes that connection's connected
-- account, keeping its agent. The connection is found as the channel read
-- finds it: the one whose live grant reaches the channel's account, or, for a
-- channel that knows no account yet, the one it was claimed for. A channel no
-- connection backs has no connected account. Where two channels name one
-- connection, the one found by its account wins.
INSERT OR IGNORE INTO `connected_accounts` (`connection_id`, `agent`)
SELECT `connection_id`, `agent` FROM (
	SELECT `g`.`custody` AS `connection_id`, `c`.`agent` AS `agent`, 0 AS `rank`
	FROM `channels` `c`
	JOIN `connection_grants` `g`
		ON `g`.`platform` = `c`.`platform`
		AND `g`.`account_id` = `c`.`platform_account_id`
		AND `g`.`state` != 'unauthorized'
	UNION ALL
	SELECT `c`.`connection_id`, `c`.`agent`, 1
	FROM `channels` `c`
	WHERE `c`.`platform_account_id` IS NULL AND `c`.`connection_id` IS NOT NULL
)
WHERE `connection_id` IN (SELECT `id` FROM `connections`)
ORDER BY `rank`;
