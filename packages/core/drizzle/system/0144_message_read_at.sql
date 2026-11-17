ALTER TABLE `chat_messages` ADD `read_at` integer;--> statement-breakpoint
UPDATE `chat_messages` SET `read_at` = `said_at`;--> statement-breakpoint
UPDATE `chat_messages` SET `root_message_id` = NULL WHERE `chat_id` IN (
  SELECT `s`.`chat_id` FROM `rome_sessions` `s` JOIN `chats` `c` ON `c`.`id` = `s`.`chat_id`
  WHERE `c`.`platform` = 'webchat' AND (`s`.`id` = 'concierge' OR coalesce(`s`.`agent_name`, '') IN ('core:concierge', 'concierge'))
);
