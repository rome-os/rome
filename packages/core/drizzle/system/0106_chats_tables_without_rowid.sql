-- agent_turn_messages and chat_addresses are keyed by composite primary keys
-- over small rows, which SQLite stores best WITHOUT ROWID
-- (https://www.sqlite.org/withoutrowid.html). Nothing writes either table
-- until the Chats switch, so they are recreated empty.
DROP TABLE `agent_turn_messages`;
--> statement-breakpoint
CREATE TABLE `agent_turn_messages` (
	`message_id` integer NOT NULL,
	`session_id` text NOT NULL,
	`turn_id` text,
	`role` text NOT NULL,
	`input_state` text,
	PRIMARY KEY(`message_id`, `session_id`),
	FOREIGN KEY (`message_id`) REFERENCES `chat_messages`(`id`) ON UPDATE no action ON DELETE cascade
) WITHOUT ROWID;
--> statement-breakpoint
CREATE INDEX `idx_agent_turn_messages_turn` ON `agent_turn_messages` (`session_id`,`turn_id`);
--> statement-breakpoint
DROP TABLE `chat_addresses`;
--> statement-breakpoint
CREATE TABLE `chat_addresses` (
	`platform` text NOT NULL,
	`account_id` text NOT NULL,
	`chat_key` text NOT NULL,
	`thread_id` text DEFAULT '' NOT NULL,
	`address` text NOT NULL,
	PRIMARY KEY(`platform`, `account_id`, `chat_key`, `thread_id`)
) WITHOUT ROWID;
--> statement-breakpoint
CREATE INDEX `idx_chat_addresses_address` ON `chat_addresses` (`platform`,`account_id`,`address`);
