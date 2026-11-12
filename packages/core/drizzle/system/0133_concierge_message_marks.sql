CREATE TABLE `concierge_message_tasks` (
	`task_id` text NOT NULL,
	`chat_id` text NOT NULL,
	`message_key` text NOT NULL,
	PRIMARY KEY(`task_id`, `chat_id`, `message_key`),
	FOREIGN KEY (`task_id`) REFERENCES `concierge_tasks`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_concierge_message_tasks_message` ON `concierge_message_tasks` (`chat_id`,`message_key`);--> statement-breakpoint
CREATE TABLE `concierge_message_turns` (
	`chat_id` text NOT NULL,
	`message_key` text NOT NULL,
	`turn_id` text NOT NULL,
	`taken_at` integer NOT NULL,
	`answered_at` integer,
	PRIMARY KEY(`chat_id`, `message_key`)
);
--> statement-breakpoint
CREATE INDEX `idx_concierge_message_turns_turn` ON `concierge_message_turns` (`chat_id`,`turn_id`);--> statement-breakpoint
ALTER TABLE `concierge_tasks` ADD `outcome_unsaid` integer DEFAULT false NOT NULL;--> statement-breakpoint
-- The marks keep only facts now. A message's turn: the newest one that took
-- it, answered unless it still worked.
INSERT OR REPLACE INTO `concierge_message_turns` (`chat_id`, `message_key`, `turn_id`, `taken_at`, `answered_at`)
  SELECT `chat_id`, `message_key`, `turn_id`, `updated_at`,
    CASE WHEN `state` = 'working' THEN NULL ELSE `updated_at` END
  FROM `concierge_turn_reactions` ORDER BY `updated_at`;
--> statement-breakpoint
-- The tasks made for a message. A stopped task's link stays: the task is
-- ended·stopped now, which shows no mark.
INSERT OR IGNORE INTO `concierge_message_tasks` (`task_id`, `chat_id`, `message_key`)
  SELECT `task_id`, `chat_id`, `message_key` FROM `concierge_task_reactions`;
--> statement-breakpoint
-- A task whose result was not said yet still owes its report.
UPDATE `concierge_tasks` SET `outcome_unsaid` = 1
  WHERE `id` IN (
    SELECT `task_id` FROM `concierge_task_reactions` WHERE `state` IN ('done_unsaid', 'failed_unsaid')
  );
