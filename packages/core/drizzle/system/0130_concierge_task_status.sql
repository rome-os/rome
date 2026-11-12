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
	`stopped_untold` integer DEFAULT false NOT NULL,
	`turn_failed` integer DEFAULT false NOT NULL,
	PRIMARY KEY(`chat_id`, `message_key`)
);
--> statement-breakpoint
CREATE INDEX `idx_concierge_message_turns_turn` ON `concierge_message_turns` (`chat_id`,`turn_id`);--> statement-breakpoint
ALTER TABLE `concierge_tasks` ADD `note` text;--> statement-breakpoint
ALTER TABLE `concierge_tasks` ADD `archived_with_chat` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `concierge_tasks` ADD `linked_at` integer;--> statement-breakpoint
ALTER TABLE `concierge_tasks` ADD `stopped_at` integer;--> statement-breakpoint
ALTER TABLE `concierge_tasks` ADD `stop_reason` text;--> statement-breakpoint
ALTER TABLE `concierge_tasks` ADD `last_outcome` text;--> statement-breakpoint
ALTER TABLE `concierge_tasks` ADD `outcome_unsaid` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `concierge_tasks` ADD `expired_wait_at` integer;--> statement-breakpoint
ALTER TABLE `concierge_tasks` ADD `no_response_unlisted` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `concierge_tasks` ADD `report_given_up` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `concierge_tasks` ADD `ended_at` integer;
--> statement-breakpoint
-- A row that links a task chat now has linked it, so it never links another.
UPDATE `concierge_tasks` SET `linked_at` = `created_at` WHERE `session_id` IS NOT NULL;
--> statement-breakpoint
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
-- A check the Concierge scheduled for a task named it `task:<id>`. It now
-- names its task in its args, so the task reads its "later" time from it and
-- stopping the task cancels it. Only a pending wake-up of a Concierge chat
-- whose name holds the id of an existing task is touched.
UPDATE `routines`
  SET `args` = json_set(`args`, '$.taskId', substr(`name`, instr(`name`, 'task:') + 5, 36))
  WHERE `action_name` = 'resume_session'
    AND `enabled` = 1
    AND json_extract(`args`, '$.agentName') = 'core:concierge'
    AND json_extract(`args`, '$.taskId') IS NULL
    AND instr(`name`, 'task:') > 0
    AND substr(`name`, instr(`name`, 'task:') + 5, 36) IN (SELECT `id` FROM `concierge_tasks`);
--> statement-breakpoint
-- A planned or watched row ends done: with no time when it was last
-- written, with a time that passed at that time. One with a time ahead, or
-- a check linked above still pending, stays later until then, and one whose
-- task chat runs reads as active. Only a row written from now on with no
-- task chat reads as later until the Concierge starts or stops it.
UPDATE `concierge_tasks`
  SET `last_outcome` = 'succeeded',
    `ended_at` = CASE
      WHEN EXISTS (
        SELECT 1 FROM `routines`
        WHERE `action_name` = 'resume_session'
          AND `enabled` = 1
          AND json_extract(`args`, '$.taskId') = `concierge_tasks`.`id`
      ) THEN NULL
      WHEN `due_at` IS NULL THEN coalesce(`completed_at`, `updated_at`)
      WHEN `due_at` <= CAST(strftime('%s', 'now') AS INTEGER) * 1000 THEN `due_at`
    END
  WHERE `state` IN ('next', 'watching') AND `last_outcome` IS NULL;
--> statement-breakpoint
-- The marks keep only facts now. A message's turn: the newest one that took
-- it, answered unless it still worked, failed if the ledger had failed it.
INSERT OR REPLACE INTO `concierge_message_turns` (`chat_id`, `message_key`, `turn_id`, `taken_at`, `answered_at`, `turn_failed`)
  SELECT `chat_id`, `message_key`, `turn_id`, `updated_at`,
    CASE WHEN `state` = 'working' THEN NULL ELSE `updated_at` END,
    CASE WHEN `state` = 'failed' THEN 1 ELSE 0 END
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
--> statement-breakpoint
-- A task whose work the ledger had failed ended failed, so its messages keep ⚠️.
UPDATE `concierge_tasks` SET `last_outcome` = 'failed'
  WHERE `id` IN (
    SELECT `task_id` FROM `concierge_task_reactions` WHERE `state` IN ('failed', 'failed_unsaid')
  );
--> statement-breakpoint
-- A row that ended before Rome kept the time ended when it finished or stopped.
UPDATE `concierge_tasks`
  SET `ended_at` = coalesce(`completed_at`, `stopped_at`, `updated_at`)
  WHERE `ended_at` IS NULL AND (`state` IN ('done', 'dropped') OR `stopped_at` IS NOT NULL);
--> statement-breakpoint
DROP TABLE `concierge_task_reactions`;
--> statement-breakpoint
DROP TABLE `concierge_turn_reactions`;
