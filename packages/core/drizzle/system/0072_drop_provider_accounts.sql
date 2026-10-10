DROP TABLE `provider_accounts`;
--> statement-breakpoint
DELETE FROM `settings` WHERE `key` IN ('telegram', 'discord', 'wechat', 'feishu', 'whatsapp', 'telegram_user');
--> statement-breakpoint
UPDATE `settings` SET `value` = json_remove(`value`, '$.address', '$.inboundSecret') WHERE `key` = 'email' AND json_valid(`value`) AND (json_type(`value`, '$.address') IS NOT NULL OR json_type(`value`, '$.inboundSecret') IS NOT NULL);
