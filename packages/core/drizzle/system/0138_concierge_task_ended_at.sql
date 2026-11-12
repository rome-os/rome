ALTER TABLE `concierge_tasks` ADD `ended_at` integer;--> statement-breakpoint
-- A row that ended before Rome kept the time ended when it finished or stopped.
UPDATE `concierge_tasks`
  SET `ended_at` = coalesce(`completed_at`, `stopped_at`, `updated_at`)
  WHERE `ended_at` IS NULL AND (`state` IN ('done', 'dropped') OR `stopped_at` IS NOT NULL);
