CREATE TABLE `concierge_turn_reactions` (
	`turn_id` text NOT NULL,
	`chat_id` text NOT NULL,
	`message_key` text NOT NULL,
	`state` text NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`turn_id`, `chat_id`, `message_key`)
);
--> statement-breakpoint
CREATE INDEX `idx_concierge_turn_reactions_message` ON `concierge_turn_reactions` (`chat_id`,`message_key`);--> statement-breakpoint
CREATE INDEX `idx_concierge_turn_reactions_chat_state` ON `concierge_turn_reactions` (`chat_id`,`state`);