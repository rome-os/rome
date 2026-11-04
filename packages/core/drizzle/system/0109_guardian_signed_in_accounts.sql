-- The guardian's signed-in accounts are theirs the moment they connect them
-- (docs/domains/people.md#account). A connection made before its setup said so
-- left the account unlinked: a Telegram or WeChat account signed in as the
-- guardian, and a LinkedIn account whose link named the profile URL rather
-- than the member id its channel records.
--
-- Link each such account to the guardian once. An account already linked to
-- anyone, or one the guardian dismissed, is left as it is.
INSERT INTO `links` (`id`, `person_id`, `platform`, `account_id`, `delegate`)
SELECT lower(hex(randomblob(16))), `guardian`.`id`, `channels`.`platform`, `channels`.`platform_account_id`, false
FROM `channels`
JOIN (
  SELECT `id` FROM `persons` WHERE `bond_level` = 'guardian' ORDER BY `created_at`, `id` LIMIT 1
) AS `guardian`
WHERE `channels`.`connection_kind` IN ('telegram_user', 'wechat_user', 'linkedin')
  AND `channels`.`connection_id` IS NOT NULL
  AND `channels`.`platform_account_id` IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM `links`
    WHERE `links`.`platform` = `channels`.`platform`
      AND `links`.`account_id` = `channels`.`platform_account_id`
  )
  AND NOT EXISTS (
    SELECT 1 FROM `dismissed_accounts`
    WHERE `dismissed_accounts`.`platform` = `channels`.`platform`
      AND `dismissed_accounts`.`account_id` = `channels`.`platform_account_id`
  );
