CREATE TABLE `task_chats` (
	`session_id` text PRIMARY KEY NOT NULL,
	`concierge_chat_id` text,
	`source_message_id` integer,
	`note` text,
	`stopped_at` integer,
	`last_outcome` text,
	`outcome_unsaid` integer DEFAULT false NOT NULL,
	`expired_wait_at` integer,
	`no_response_unlisted` integer DEFAULT false NOT NULL,
	`report_given_up` integer DEFAULT false NOT NULL,
	`ended_at` integer,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `rome_sessions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`concierge_chat_id`) REFERENCES `rome_sessions`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`source_message_id`) REFERENCES `chat_messages`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
-- A task is its task chat now: each row moves to its chat's id. A row with no
-- chat, one that was never started or whose chat was deleted, ends: it is not
-- moved. The title, the owner, the creation time, the summary, the state,
-- the rank, the due time, what it waited on and the not-started reminder are
-- not kept; the chat's own name, owner and creation time stand for them.
INSERT INTO `task_chats` (
	`session_id`, `concierge_chat_id`, `source_message_id`, `note`, `stopped_at`, `last_outcome`,
	`outcome_unsaid`, `expired_wait_at`, `no_response_unlisted`, `report_given_up`, `ended_at`, `updated_at`
)
SELECT t.`session_id`, t.`chat_id`, t.`source_message_id`, t.`note`, t.`stopped_at`, t.`last_outcome`,
	t.`outcome_unsaid`, t.`expired_wait_at`, t.`no_response_unlisted`, t.`report_given_up`, t.`ended_at`, t.`updated_at`
FROM `concierge_tasks` t
WHERE t.`session_id` IS NOT NULL AND t.`session_id` IN (SELECT `id` FROM `rome_sessions`);
--> statement-breakpoint
-- A row archived on its own, with no archive of its chat, archives the chat:
-- archiving is the chat's now.
UPDATE `rome_sessions`
	SET `archived_at` = (SELECT t.`archived_at` / 1000 FROM `concierge_tasks` t WHERE t.`session_id` = `rome_sessions`.`id`)
	WHERE `archived_at` IS NULL
		AND `id` IN (SELECT `session_id` FROM `concierge_tasks` WHERE `session_id` IS NOT NULL AND `archived_at` IS NOT NULL);
--> statement-breakpoint
-- A task chat from before the todo list has no row: it gets one, ended when
-- its chat was last active, reporting to its owner's main chat.
INSERT INTO `task_chats` (`session_id`, `concierge_chat_id`, `stopped_at`, `ended_at`, `updated_at`)
SELECT s.`id`, NULL, NULL, s.`activity_at` * 1000, s.`activity_at` * 1000
FROM `rome_sessions` s
WHERE s.`trigger_kind` = 'concierge'
	AND coalesce(s.`agent_name`, '') NOT IN ('core:concierge', 'concierge')
	AND s.`id` <> 'concierge'
	AND s.`id` NOT IN (SELECT `session_id` FROM `task_chats`);
--> statement-breakpoint
-- The tasks made for a message point at their chat's id.
CREATE TABLE `__new_concierge_message_tasks` (
	`task_chat_id` text NOT NULL,
	`chat_id` text NOT NULL,
	`message_key` text NOT NULL,
	`seq` integer DEFAULT 0 NOT NULL,
	`ended_as` text,
	PRIMARY KEY(`task_chat_id`, `chat_id`, `message_key`),
	FOREIGN KEY (`task_chat_id`) REFERENCES `task_chats`(`session_id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `__new_concierge_message_tasks` (`task_chat_id`, `chat_id`, `message_key`, `seq`, `ended_as`)
SELECT t.`session_id`, m.`chat_id`, m.`message_key`, m.`seq`, m.`ended_as`
FROM `concierge_message_tasks` m
JOIN `concierge_tasks` t ON t.`id` = m.`task_id`
WHERE t.`session_id` IN (SELECT `session_id` FROM `task_chats`);
--> statement-breakpoint
DROP TABLE `concierge_message_tasks`;
--> statement-breakpoint
ALTER TABLE `__new_concierge_message_tasks` RENAME TO `concierge_message_tasks`;
--> statement-breakpoint
CREATE INDEX `idx_concierge_message_tasks_message` ON `concierge_message_tasks` (`chat_id`,`message_key`);
--> statement-breakpoint
-- A check for a task names the task's chat, not its row. One whose task has no
-- chat is a plain check.
UPDATE `routines`
	SET `args` = json_set(
		json_remove(`args`, '$.taskId'),
		'$.chatId',
		(SELECT t.`session_id` FROM `concierge_tasks` t WHERE t.`id` = json_extract(`routines`.`args`, '$.taskId'))
	)
	WHERE `action_name` IN ('resume_session', 'system:resume_session')
		AND json_valid(`args`)
		AND json_type(`args`, '$.taskId') = 'text'
		AND json_extract(`args`, '$.taskId') IN (
			SELECT t.`id` FROM `concierge_tasks` t WHERE t.`session_id` IN (SELECT `session_id` FROM `task_chats`)
		);
--> statement-breakpoint
UPDATE `routines` SET `args` = json_remove(`args`, '$.taskId')
	WHERE `action_name` IN ('resume_session', 'system:resume_session')
		AND json_valid(`args`)
		AND json_type(`args`, '$.taskId') IS NOT NULL;
--> statement-breakpoint
-- A task's schedule is keyed by its chat's id. The schedule of a task with no
-- chat has nothing to run in and goes.
UPDATE `routines`
	SET `key` = 'concierge-task-schedule:' || (
			SELECT t.`session_id` FROM `concierge_tasks` t WHERE t.`id` = json_extract(`routines`.`args`, '$.taskId')),
		`args` = json_set(
			json_remove(`args`, '$.taskId'),
			'$.chatId',
			(SELECT t.`session_id` FROM `concierge_tasks` t WHERE t.`id` = json_extract(`routines`.`args`, '$.taskId')))
	WHERE `action_name` = 'core:concierge_task_run'
		AND json_valid(`args`)
		AND json_type(`args`, '$.taskId') = 'text'
		AND json_extract(`args`, '$.taskId') IN (
			SELECT t.`id` FROM `concierge_tasks` t WHERE t.`session_id` IN (SELECT `session_id` FROM `task_chats`)
		);
--> statement-breakpoint
DELETE FROM `routine_runs` WHERE `routine_id` IN (
	SELECT `id` FROM `routines`
	WHERE `action_name` = 'core:concierge_task_run' AND json_valid(`args`) AND json_type(`args`, '$.taskId') IS NOT NULL
);
--> statement-breakpoint
DELETE FROM `routines`
	WHERE `action_name` = 'core:concierge_task_run' AND json_valid(`args`) AND json_type(`args`, '$.taskId') IS NOT NULL;
--> statement-breakpoint
DROP TABLE `concierge_tasks`;
