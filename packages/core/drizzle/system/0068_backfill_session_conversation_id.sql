-- Each rule writes only an id that rome_sessions already holds, and only
-- where conversation_id is still null, so a row no rule can place stays null.
-- Rows whose own session id was minted as a conversation: subagents and
-- persisted forks.
UPDATE `sessions` SET `conversation_id` = `id`
WHERE `conversation_id` IS NULL
  AND (`channel_thread_key` LIKE '%:subagent:%' OR `channel_thread_key` LIKE 'webchat:%')
  AND `id` IN (SELECT `id` FROM `rome_sessions`);--> statement-breakpoint
-- Webchat and persisted fork rows: `webchat:<id>` or `webchat:<id>:large-model:<selection>`.
UPDATE `sessions` SET `conversation_id` = CASE
    WHEN instr(substr(`channel_thread_key`, 9), ':') > 0
      THEN substr(`channel_thread_key`, 9, instr(substr(`channel_thread_key`, 9), ':') - 1)
    ELSE substr(`channel_thread_key`, 9)
  END
WHERE `conversation_id` IS NULL
  AND `channel_thread_key` LIKE 'webchat:%'
  AND `channel_thread_key` NOT LIKE '%:subagent:%'
  AND (CASE
    WHEN instr(substr(`channel_thread_key`, 9), ':') > 0
      THEN substr(`channel_thread_key`, 9, instr(substr(`channel_thread_key`, 9), ':') - 1)
    ELSE substr(`channel_thread_key`, 9)
  END) IN (SELECT `id` FROM `rome_sessions`);--> statement-breakpoint
-- Channel rows: `<channel>:<thread>` serves `channel:<channel>:<thread>`.
UPDATE `sessions` SET `conversation_id` = 'channel:' || `channel_thread_key`
WHERE `conversation_id` IS NULL
  AND `channel_thread_key` NOT LIKE 'webchat:%'
  AND `channel_thread_key` NOT LIKE 'sentinel:%'
  AND `channel_thread_key` NOT LIKE '%:subagent:%'
  AND ('channel:' || `channel_thread_key`) IN (SELECT `id` FROM `rome_sessions`);--> statement-breakpoint
-- Sentinel rows: `sentinel:<channel>:<thread>` serves the same channel conversation.
UPDATE `sessions` SET `conversation_id` = 'channel:' || substr(`channel_thread_key`, 10)
WHERE `conversation_id` IS NULL
  AND `channel_thread_key` LIKE 'sentinel:%'
  AND `channel_thread_key` NOT LIKE '%:subagent:%'
  AND ('channel:' || substr(`channel_thread_key`, 10)) IN (SELECT `id` FROM `rome_sessions`);
