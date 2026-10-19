-- Guardian chats become channel rows on the webchat channel. Before the flip,
-- a channel row on that channel whose address is not its own id is a stray:
-- an earlier app send or backend turn recorded a copy of a line the chat
-- already holds under `channel:webchat:<id>`. Remove those rows and what hangs
-- off them, so the chats are the only rows left on the webchat channel.
DELETE FROM `rome_agent_trace_blocks` WHERE `session_id` IN (SELECT `id` FROM `rome_sessions` WHERE `type` = 'channel' AND `source_channel` = 'webchat' AND coalesce(`source_thread_id`, '') <> `id`);--> statement-breakpoint
DELETE FROM `rome_agent_messages` WHERE `session_id` IN (SELECT `id` FROM `rome_sessions` WHERE `type` = 'channel' AND `source_channel` = 'webchat' AND coalesce(`source_thread_id`, '') <> `id`);--> statement-breakpoint
DELETE FROM `webchat_turn_feedback` WHERE `session_id` IN (SELECT `id` FROM `rome_sessions` WHERE `type` = 'channel' AND `source_channel` = 'webchat' AND coalesce(`source_thread_id`, '') <> `id`);--> statement-breakpoint
DELETE FROM `webchat_workspace_layouts` WHERE `session_id` IN (SELECT `id` FROM `rome_sessions` WHERE `type` = 'channel' AND `source_channel` = 'webchat' AND coalesce(`source_thread_id`, '') <> `id`);--> statement-breakpoint
DELETE FROM `shared_chats` WHERE `session_id` IN (SELECT `id` FROM `rome_sessions` WHERE `type` = 'channel' AND `source_channel` = 'webchat' AND coalesce(`source_thread_id`, '') <> `id`);--> statement-breakpoint
UPDATE `rome_sessions` SET `parent_session_id` = NULL WHERE `parent_session_id` IN (SELECT `id` FROM `rome_sessions` WHERE `type` = 'channel' AND `source_channel` = 'webchat' AND coalesce(`source_thread_id`, '') <> `id`);--> statement-breakpoint
DELETE FROM `rome_sessions` WHERE `type` = 'channel' AND `source_channel` = 'webchat' AND coalesce(`source_thread_id`, '') <> `id`;--> statement-breakpoint
-- A chat answers at its own address. Forks promoted to chats still carry
-- their parent's, so set it on every chat as it moves.
UPDATE `rome_sessions`
SET `type` = 'channel', `source_channel` = 'webchat', `source_thread_id` = `id`
WHERE `type` = 'webchat';--> statement-breakpoint
DROP INDEX `idx_rome_sessions_sidebar_activity`;--> statement-breakpoint
DROP INDEX `idx_rome_sessions_project_activity`;--> statement-breakpoint
CREATE INDEX `idx_rome_sessions_chat_activity` ON `rome_sessions` (`activity_at`,`created_at`,`id`) WHERE ("rome_sessions"."type" = 'channel' and +"rome_sessions"."source_channel" = 'webchat');--> statement-breakpoint
CREATE INDEX `idx_rome_sessions_chat_project_activity` ON `rome_sessions` (`project_path`,`activity_at`,`created_at`,`id`) WHERE ("rome_sessions"."type" = 'channel' and +"rome_sessions"."source_channel" = 'webchat');