-- Chats' tables (docs/domains/chats.md). Every id is an integer; the
-- adapter's key for a chat or a line sits beside it, unique on its platform or
-- in its chat. They start empty and nothing reads or writes them yet: the
-- switch migration fills them from the legacy rows in the release that moves
-- every reader and writer onto them.
CREATE TABLE `chats` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`platform` text NOT NULL,
	`key` text NOT NULL,
	`kind` text NOT NULL,
	`name` text,
	`started_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_chats_key` ON `chats` (`platform`,`key`);
--> statement-breakpoint
CREATE TABLE `chat_messages` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
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
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_chat_messages_key` ON `chat_messages` (`chat_id`,`key`);
--> statement-breakpoint
CREATE INDEX `idx_chat_messages_page` ON `chat_messages` (`chat_id`,`thread_id`,`said_at`,`id`);
--> statement-breakpoint
CREATE TABLE `agent_turn_messages` (
	`message_id` integer NOT NULL,
	`session_id` text NOT NULL,
	`turn_id` text,
	`role` text NOT NULL,
	`input_state` text,
	PRIMARY KEY(`message_id`, `session_id`),
	FOREIGN KEY (`message_id`) REFERENCES `chat_messages`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_agent_turn_messages_turn` ON `agent_turn_messages` (`session_id`,`turn_id`);
--> statement-breakpoint
CREATE TABLE `chat_addresses` (
	`platform` text NOT NULL,
	`account_id` text NOT NULL,
	`chat_key` text NOT NULL,
	`thread_id` text DEFAULT '' NOT NULL,
	`address` text NOT NULL,
	PRIMARY KEY(`platform`, `account_id`, `chat_key`, `thread_id`)
);
--> statement-breakpoint
CREATE INDEX `idx_chat_addresses_address` ON `chat_addresses` (`platform`,`account_id`,`address`);
--> statement-breakpoint
ALTER TABLE `rome_sessions` ADD `chat_id` integer;
--> statement-breakpoint
ALTER TABLE `rome_sessions` ADD `chat_platform` text;
--> statement-breakpoint
ALTER TABLE `rome_sessions` ADD `thread_id` text;
--> statement-breakpoint
ALTER TABLE `rome_sessions` ADD `account_id` text;
--> statement-breakpoint
CREATE INDEX `idx_rome_sessions_chat` ON `rome_sessions` (`chat_id`,`thread_id`);
