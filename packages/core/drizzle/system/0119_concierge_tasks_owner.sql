ALTER TABLE `concierge_tasks` ADD `owner_key` text;--> statement-breakpoint
-- A row is its chat's owner's: a visitor's chat records "visitor:<account>",
-- and a deleted visitor chat's owner was kept by the Concierge in settings.
-- Anything else stays null, the guardian, as before.
UPDATE `concierge_tasks` SET `owner_key` = coalesce(
  (SELECT `owner_key` FROM `rome_sessions` WHERE `rome_sessions`.`id` = `concierge_tasks`.`chat_id`),
  (SELECT json_extract(`value`, '$."' || `concierge_tasks`.`chat_id` || '"') FROM `settings` WHERE `key` = 'conciergeRetiredChats')
)
WHERE `chat_id` IS NOT NULL;
