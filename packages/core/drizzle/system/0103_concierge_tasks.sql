CREATE TABLE `concierge_tasks` (
	`id` text PRIMARY KEY NOT NULL,
	`title` text NOT NULL,
	`state` text NOT NULL,
	`summary` text,
	`waiting_on` text,
	`due_at` integer,
	`rank` integer,
	`session_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`completed_at` integer,
	`archived_at` integer,
	FOREIGN KEY (`session_id`) REFERENCES `rome_sessions`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_concierge_tasks_session` ON `concierge_tasks` (`session_id`) WHERE "concierge_tasks"."session_id" is not null;--> statement-breakpoint
-- Task chats the Concierge started in the last 7 days become `doing` rows, so
-- the todo list opens with what is running. Older chats are not backfilled, and
-- neither are archived ones. The title is the name the Concierge gave the chat.
--
-- `updated_at` is set a millisecond before the chat's last activity, so the
-- startup catch-up (a chat active after its row was written) hands each of
-- these rows to the Concierge once, and it sorts them into their real states.
INSERT INTO `concierge_tasks` (`id`, `title`, `state`, `session_id`, `created_at`, `updated_at`)
SELECT
  lower(
    hex(randomblob(4)) || '-' || hex(randomblob(2)) || '-4' || substr(hex(randomblob(2)), 2) || '-' ||
    substr('89ab', abs(random()) % 4 + 1, 1) || substr(hex(randomblob(2)), 2) || '-' || hex(randomblob(6))
  ),
  coalesce(`trigger_name`, `name`),
  'doing',
  `id`,
  `created_at` * 1000,
  `activity_at` * 1000 - 1
FROM `rome_sessions`
WHERE `trigger_kind` = 'concierge'
  AND `archived_at` IS NULL
  AND `activity_at` >= cast(strftime('%s', 'now') as integer) - 7 * 86400;
