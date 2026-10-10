CREATE TABLE `outbound_messages` (
	`id` text PRIMARY KEY NOT NULL,
	`channel` text NOT NULL,
	`channel_user_id` text NOT NULL,
	`conversation_id` text NOT NULL,
	`text` text NOT NULL,
	`state` text NOT NULL,
	`provider_message_id` text,
	`error` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_outbound_account` ON `outbound_messages` (`channel`,`channel_user_id`);