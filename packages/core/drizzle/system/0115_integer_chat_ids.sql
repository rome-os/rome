-- Chats keys every chat and message by an integer, beside the adapter's own
-- key. Each row keeps its old rowid as its id, so references resolve through
-- the old tables' primary keys before they go.
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_chats` (
	`id` integer PRIMARY KEY NOT NULL,
	`platform` text NOT NULL,
	`key` text NOT NULL,
	`kind` text NOT NULL,
	`name` text,
	`started_at` integer NOT NULL
);--> statement-breakpoint
CREATE TABLE `__new_chat_messages` (
	`id` integer PRIMARY KEY NOT NULL,
	`chat_id` integer NOT NULL,
	`key` text NOT NULL,
	`thread_id` text,
	`sender_account_id` text,
	`sender_agent` text,
	`sender_name` text,
	`text` text NOT NULL,
	`parts` text NOT NULL,
	`reply_to_message_id` integer,
	`said_at` integer NOT NULL,
	FOREIGN KEY (`chat_id`) REFERENCES `chats`(`id`) ON UPDATE no action ON DELETE cascade
);--> statement-breakpoint
CREATE TABLE `__new_agent_turn_messages` (
	`message_id` integer NOT NULL,
	`session_id` text NOT NULL,
	`turn_id` text,
	`role` text NOT NULL,
	`input_state` text,
	PRIMARY KEY(`message_id`, `session_id`),
	FOREIGN KEY (`message_id`) REFERENCES `chat_messages`(`id`) ON UPDATE no action ON DELETE cascade
);--> statement-breakpoint
CREATE TABLE `__new_concierge_tasks` (
	`id` text PRIMARY KEY NOT NULL,
	`title` text NOT NULL,
	`state` text NOT NULL,
	`summary` text,
	`waiting_on` text,
	`due_at` integer,
	`rank` integer,
	`session_id` text,
	`source_message_id` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`completed_at` integer,
	`archived_at` integer,
	FOREIGN KEY (`session_id`) REFERENCES `rome_sessions`(`id`) ON UPDATE no action ON DELETE set null
);--> statement-breakpoint
CREATE TABLE `__new_rome_sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_key` text,
	`name` text NOT NULL,
	`persona_id` text,
	`large_model_selection` text,
	`project_name` text DEFAULT 'default' NOT NULL,
	`project_path` text,
	`device_folder` text,
	`agent_name` text,
	`type` text DEFAULT 'webchat' NOT NULL,
	`thread_name` text,
	`channel_settings` text,
	`trigger_kind` text,
	`trigger_name` text,
	`trigger_action_name` text,
	`trigger_execution_id` text,
	`root_action_execution_id` text,
	`parent_action_execution_id` text,
	`parent_session_id` text,
	`parent_turn_id` text,
	`handoff_spec` text,
	`archived_at` integer,
	`pinned_at` integer,
	`created_at` integer NOT NULL,
	`activity_at` integer NOT NULL,
	`last_seen_activity_at` integer,
	`chat_id` integer,
	`chat_platform` text,
	`thread_id` text,
	`account_id` text
);--> statement-breakpoint
INSERT INTO `__new_chats`("id", "platform", "key", "kind", "name", "started_at")
SELECT rowid, platform,
  CASE WHEN platform <> 'webchat' AND substr(id, 1, length(platform) + 1) = platform || ':'
    THEN substr(id, length(platform) + 2) ELSE id END,
  kind, name, started_at
FROM `chats`;--> statement-breakpoint
INSERT INTO `__new_chat_messages`("id", "chat_id", "key", "thread_id", "sender_account_id", "sender_agent", "sender_name", "text", "parts", "reply_to_message_id", "said_at")
SELECT m.rowid, c.rowid,
  CASE WHEN substr(m.id, 1, length(m.chat_id) + 1) = m.chat_id || '/'
    THEN substr(m.id, length(m.chat_id) + 2) ELSE m.id END,
  m.thread_id, m.sender_account_id, m.sender_agent, m.sender_name, m.text, m.parts,
  (SELECT r.rowid FROM `chat_messages` r WHERE r.id = m.reply_to_message_id),
  m.said_at
FROM `chat_messages` m JOIN `chats` c ON c.id = m.chat_id;--> statement-breakpoint
INSERT INTO `__new_agent_turn_messages`("message_id", "session_id", "turn_id", "role", "input_state")
SELECT m.rowid, a.session_id, a.turn_id, a.role, a.input_state
FROM `agent_turn_messages` a JOIN `chat_messages` m ON m.id = a.message_id;--> statement-breakpoint
INSERT INTO `__new_concierge_tasks`("id", "title", "state", "summary", "waiting_on", "due_at", "rank", "session_id", "source_message_id", "created_at", "updated_at", "completed_at", "archived_at") SELECT "id", "title", "state", "summary", "waiting_on", "due_at", "rank", "session_id", (SELECT m.rowid FROM `chat_messages` m WHERE m.id = t.source_message_id), "created_at", "updated_at", "completed_at", "archived_at" FROM `concierge_tasks` t;--> statement-breakpoint
INSERT INTO `__new_rome_sessions`("id", "owner_key", "name", "persona_id", "large_model_selection", "project_name", "project_path", "device_folder", "agent_name", "type", "thread_name", "channel_settings", "trigger_kind", "trigger_name", "trigger_action_name", "trigger_execution_id", "root_action_execution_id", "parent_action_execution_id", "parent_session_id", "parent_turn_id", "handoff_spec", "archived_at", "pinned_at", "created_at", "activity_at", "last_seen_activity_at", "chat_id", "chat_platform", "thread_id", "account_id") SELECT "id", "owner_key", "name", "persona_id", "large_model_selection", "project_name", "project_path", "device_folder", "agent_name", "type", "thread_name", "channel_settings", "trigger_kind", "trigger_name", "trigger_action_name", "trigger_execution_id", "root_action_execution_id", "parent_action_execution_id", "parent_session_id", "parent_turn_id", "handoff_spec", "archived_at", "pinned_at", "created_at", "activity_at", "last_seen_activity_at", (SELECT c.rowid FROM `chats` c WHERE c.id = s.chat_id), "chat_platform", "thread_id", "account_id" FROM `rome_sessions` s;--> statement-breakpoint
DROP TABLE `agent_turn_messages`;--> statement-breakpoint
DROP TABLE `chat_messages`;--> statement-breakpoint
DROP TABLE `chats`;--> statement-breakpoint
DROP TABLE `concierge_tasks`;--> statement-breakpoint
DROP TABLE `rome_sessions`;--> statement-breakpoint
ALTER TABLE `__new_chats` RENAME TO `chats`;--> statement-breakpoint
ALTER TABLE `__new_chat_messages` RENAME TO `chat_messages`;--> statement-breakpoint
ALTER TABLE `__new_agent_turn_messages` RENAME TO `agent_turn_messages`;--> statement-breakpoint
ALTER TABLE `__new_concierge_tasks` RENAME TO `concierge_tasks`;--> statement-breakpoint
ALTER TABLE `__new_rome_sessions` RENAME TO `rome_sessions`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `idx_agent_turn_messages_turn` ON `agent_turn_messages` (`session_id`,`turn_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_chat_messages_key` ON `chat_messages` (`chat_id`,`key`);--> statement-breakpoint
CREATE INDEX `idx_chat_messages_page` ON `chat_messages` (`chat_id`,`thread_id`,`said_at`,`id`);--> statement-breakpoint
CREATE INDEX `idx_chat_messages_place` ON `chat_messages` (`chat_id`,`thread_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_chats_key` ON `chats` (`platform`,`key`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_concierge_tasks_session` ON `concierge_tasks` (`session_id`) WHERE "concierge_tasks"."session_id" is not null;--> statement-breakpoint
CREATE INDEX `idx_rome_sessions_chat` ON `rome_sessions` (`chat_id`,`thread_id`);--> statement-breakpoint
CREATE INDEX `idx_rome_sessions_owner_key` ON `rome_sessions` (`owner_key`);--> statement-breakpoint
CREATE INDEX `idx_rome_sessions_project_path` ON `rome_sessions` (`project_path`);--> statement-breakpoint
CREATE INDEX `idx_rome_sessions_activity` ON `rome_sessions` (`activity_at`,`created_at`,`id`);--> statement-breakpoint
CREATE INDEX `idx_rome_sessions_dashboard_activity` ON `rome_sessions` (`activity_at`,`created_at`,`id`) WHERE ("rome_sessions"."type" = 'channel' and "rome_sessions"."chat_platform" = 'webchat');--> statement-breakpoint
CREATE INDEX `idx_rome_sessions_dashboard_project_activity` ON `rome_sessions` (`project_path`,`activity_at`,`created_at`,`id`) WHERE ("rome_sessions"."type" = 'channel' and "rome_sessions"."chat_platform" = 'webchat');--> statement-breakpoint
CREATE INDEX `idx_rome_sessions_account` ON `rome_sessions` (`account_id`);--> statement-breakpoint
CREATE INDEX `idx_rome_sessions_parent_session` ON `rome_sessions` (`parent_session_id`);
