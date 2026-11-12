ALTER TABLE `concierge_message_turns` ADD `turn_failed` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `concierge_tasks` ADD `report_given_up` integer DEFAULT false NOT NULL;--> statement-breakpoint
-- A message whose turn the ledger had failed keeps its ⚠️.
UPDATE `concierge_message_turns` SET `turn_failed` = 1
  WHERE EXISTS (
    SELECT 1 FROM `concierge_turn_reactions` r
    WHERE r.`chat_id` = `concierge_message_turns`.`chat_id`
      AND r.`message_key` = `concierge_message_turns`.`message_key`
      AND r.`turn_id` = `concierge_message_turns`.`turn_id`
      AND r.`state` = 'failed'
  );
--> statement-breakpoint
-- A task whose work the ledger had failed ended failed, so its messages keep ⚠️.
UPDATE `concierge_tasks` SET `last_outcome` = 'failed'
  WHERE `id` IN (
    SELECT `task_id` FROM `concierge_task_reactions` WHERE `state` IN ('failed', 'failed_unsaid')
  );
--> statement-breakpoint
DROP TABLE `concierge_task_reactions`;
--> statement-breakpoint
DROP TABLE `concierge_turn_reactions`;
