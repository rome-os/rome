-- Contract: every reader and writer now uses Chats (`chats`, `chat_messages`)
-- and Agents' turn links (`agent_turn_messages`). A chat session's user,
-- assistant and notification rows were copied into Chats by 0105, so they go.
-- A subagent's and a fork's rows stay: neither stands in a chat. Traces stay.
-- `source_channel` stays until every seat is found by `chat_id`.
DELETE FROM `rome_agent_messages`
WHERE `role` IN ('user', 'assistant', 'notification')
  AND `session_id` IN (SELECT `id` FROM `rome_sessions` WHERE `chat_id` IS NOT NULL);--> statement-breakpoint
DROP TABLE `rome_agent_message_platform_ids`;--> statement-breakpoint
DROP INDEX `idx_rome_agent_messages_platform_message`;--> statement-breakpoint
ALTER TABLE `rome_agent_messages` DROP COLUMN `input_state`;--> statement-breakpoint
ALTER TABLE `rome_agent_messages` DROP COLUMN `platform_message_id`;--> statement-breakpoint
ALTER TABLE `rome_agent_messages` DROP COLUMN `reply_to_platform_message_id`;--> statement-breakpoint
ALTER TABLE `rome_agent_messages` DROP COLUMN `context_injected_turn_id`;
