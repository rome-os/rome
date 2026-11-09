DROP INDEX `idx_concierge_follow_items_event`;--> statement-breakpoint
ALTER TABLE `concierge_follow_items` ADD `owner_key` text DEFAULT 'guardian' NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `idx_concierge_follow_items_owner_event` ON `concierge_follow_items` (`owner_key`,`event_id`);--> statement-breakpoint
ALTER TABLE `concierge_tasks` ADD `owner_key` text DEFAULT 'guardian' NOT NULL;--> statement-breakpoint
-- A task row is its chat's owner's. A visitor's chat records "visitor:<account>".
UPDATE `concierge_tasks` SET `owner_key` = coalesce(
  (SELECT `owner_key` FROM `rome_sessions` WHERE `rome_sessions`.`id` = `concierge_tasks`.`chat_id`),
  'guardian'
)
WHERE `chat_id` IS NOT NULL;--> statement-breakpoint
-- A child session (a fork, a branch promoted to a chat, a subagent) made
-- before children were marked at creation: one of a Concierge chat or a
-- Concierge task chat is marked private to that chat's owner, as a new one is.
UPDATE `rome_sessions` SET
  `trigger_kind` = 'concierge_fork',
  `owner_key` = (
    SELECT coalesce(p.`owner_key`, 'guardian') FROM `rome_sessions` p
    WHERE p.`id` = `rome_sessions`.`parent_session_id`
  )
WHERE (
    `type` IN ('fork', 'subagent')
    -- A branch promoted to an ordinary chat keeps its parent and its fork mark.
    OR (`type` = 'channel' AND `trigger_kind` = 'fork')
  )
  AND coalesce(`agent_name`, '') NOT IN ('core:concierge', 'concierge')
  AND EXISTS (
    SELECT 1 FROM `rome_sessions` p
    WHERE p.`id` = `rome_sessions`.`parent_session_id`
      AND (
        p.`id` = 'concierge'
        OR coalesce(p.`agent_name`, '') IN ('core:concierge', 'concierge')
        OR coalesce(p.`trigger_kind`, '') IN ('concierge', 'concierge_fork')
      )
  );
