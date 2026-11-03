ALTER TABLE `channels` ADD `agent` text;--> statement-breakpoint
CREATE UNIQUE INDEX `channels_platform_agent_unique` ON `channels` (`platform`,`agent`) WHERE "channels"."agent" IS NOT NULL AND "channels"."agent" <> 'core:main';--> statement-breakpoint
-- An account with no linked agent will be silent, so every account of a
-- linkable service that a Connection backs keeps answering, as main.
UPDATE `channels` SET `agent` = 'core:main'
WHERE `service` IN ('feishu', 'telegram', 'discord', 'telegram_user')
  AND `connection_id` IS NOT NULL;