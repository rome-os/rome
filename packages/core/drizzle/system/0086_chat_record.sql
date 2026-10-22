-- The chat record (docs/domains/chats.md): chats, the Rome accounts in them,
-- their threads, and what was said, written beside today's conversation rows.
CREATE TABLE `chat_accounts` (
	`chat_id` text NOT NULL,
	`channel` text NOT NULL,
	`first_seen_at` integer NOT NULL,
	PRIMARY KEY(`chat_id`, `channel`),
	FOREIGN KEY (`chat_id`) REFERENCES `chats`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `chat_messages` (
	`id` text PRIMARY KEY NOT NULL,
	`chat_id` text NOT NULL,
	`platform_thread_id` text,
	`platform_message_id` text NOT NULL,
	`direction` text NOT NULL,
	`channel` text,
	`sender_id` text,
	`sender_name` text,
	`agent_name` text,
	`parts` text NOT NULL,
	`reply_to_platform_message_id` text,
	`said_at` integer NOT NULL,
	FOREIGN KEY (`chat_id`) REFERENCES `chats`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_chat_messages_platform_message` ON `chat_messages` (`chat_id`,`platform_message_id`);--> statement-breakpoint
CREATE INDEX `idx_chat_messages_chat_said_at` ON `chat_messages` (`chat_id`,`said_at`);--> statement-breakpoint
CREATE INDEX `idx_chat_messages_thread_said_at` ON `chat_messages` (`chat_id`,`platform_thread_id`,`said_at`);--> statement-breakpoint
CREATE TABLE `chat_threads` (
	`chat_id` text NOT NULL,
	`platform_thread_id` text NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`chat_id`, `platform_thread_id`),
	FOREIGN KEY (`chat_id`) REFERENCES `chats`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `chats` (
	`id` text PRIMARY KEY NOT NULL,
	`platform` text NOT NULL,
	`platform_chat_id` text NOT NULL,
	`kind` text NOT NULL,
	`rome_channel` text,
	`created_at` integer NOT NULL
);
