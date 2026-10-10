-- Each rule writes only an id that rome_sessions already holds, and only
-- where conversation_id is still null, so a row no rule can place stays null.
-- Subagent rows serve the conversation minted under their own session id.
UPDATE `sessions` SET `conversation_id` = `id`
WHERE `conversation_id` IS NULL
  AND `channel_thread_key` LIKE '%:subagent:%'
  AND `id` IN (SELECT `id` FROM `rome_sessions`);--> statement-breakpoint
-- Webchat and persisted fork rows: `webchat:<id>`. 0073 already stripped the
-- model-choice segment, so any key with a later segment is not a bare chat.
UPDATE `sessions` SET `conversation_id` = substr(`channel_thread_key`, 9)
WHERE `conversation_id` IS NULL
  AND `channel_thread_key` LIKE 'webchat:%'
  AND `channel_thread_key` NOT LIKE 'webchat:%:%'
  AND substr(`channel_thread_key`, 9) IN (SELECT `id` FROM `rome_sessions`);--> statement-breakpoint
-- Channel rows: `<channel>:<thread>` serves `channel:<channel>:<thread>`.
UPDATE `sessions` SET `conversation_id` = 'channel:' || `channel_thread_key`
WHERE `conversation_id` IS NULL
  AND `channel_thread_key` NOT LIKE 'webchat:%'
  AND `channel_thread_key` NOT LIKE 'sentinel:%'
  AND `channel_thread_key` NOT LIKE '%:subagent:%'
  AND ('channel:' || `channel_thread_key`) IN (SELECT `id` FROM `rome_sessions`);
