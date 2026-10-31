ALTER TABLE `rome_sessions` RENAME COLUMN "source_thread_name" TO "thread_name";--> statement-breakpoint
-- Only a topic's seat keeps a name of its own; a chat's name is the chat's.
UPDATE `rome_sessions` SET `thread_name` = NULL WHERE `thread_id` IS NULL;--> statement-breakpoint
ALTER TABLE `rome_sessions` DROP COLUMN `source_channel`;--> statement-breakpoint
ALTER TABLE `rome_sessions` DROP COLUMN `source_thread_id`;--> statement-breakpoint
ALTER TABLE `rome_sessions` DROP COLUMN `source_thread_type`;--> statement-breakpoint
ALTER TABLE `rome_agent_messages` DROP COLUMN `sender_id`;--> statement-breakpoint
ALTER TABLE `rome_agent_messages` DROP COLUMN `sender_name`;