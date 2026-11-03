-- A conversation is a chat (docs/domains/chats.md), so the columns that hold
-- a chat's id say so. Renaming keeps every row and the index's entries.
ALTER TABLE `sessions` RENAME COLUMN `conversation_id` TO `chat_id`;--> statement-breakpoint
DROP INDEX IF EXISTS `idx_sessions_conversation`;--> statement-breakpoint
CREATE INDEX `idx_sessions_chat` ON `sessions` (`chat_id`);--> statement-breakpoint
ALTER TABLE `outbound_messages` RENAME COLUMN `conversation_id` TO `chat_id`;
