ALTER TABLE `concierge_tasks` ADD `note` text;--> statement-breakpoint
-- Rome derives a task's status from facts now. The states the Concierge
-- wrote become the facts they stood for; every other row is read from its
-- task chat. A row it marked done ended done.
UPDATE `concierge_tasks` SET `last_outcome` = 'succeeded'
  WHERE `state` = 'done' AND `last_outcome` IS NULL;
--> statement-breakpoint
-- A row it dropped was called off: it is stopped, when it finished.
UPDATE `concierge_tasks`
  SET `stopped_at` = coalesce(`completed_at`, `updated_at`), `stop_reason` = 'concierge'
  WHERE `state` = 'dropped' AND `stopped_at` IS NULL;
--> statement-breakpoint
-- A planned or watched row with no time ended done. One with a time stays
-- later until that time, and one whose task chat runs reads as active.
UPDATE `concierge_tasks` SET `last_outcome` = 'succeeded'
  WHERE `state` IN ('next', 'watching') AND `due_at` IS NULL AND `last_outcome` IS NULL;
