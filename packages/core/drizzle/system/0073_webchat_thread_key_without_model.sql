-- Webchat keys no longer carry the chat's model selection, which lives on
-- rome_sessions.large_model_selection. Strip the `:large-model:<id>` segment
-- and keep anything after it, such as a subagent's `:subagent:<uuid>`.
-- Selection ids never contain a colon.
UPDATE `sessions`
SET `channel_thread_key` =
  substr(`channel_thread_key`, 1, instr(`channel_thread_key`, ':large-model:') - 1)
  || CASE
    WHEN instr(substr(`channel_thread_key`, instr(`channel_thread_key`, ':large-model:') + 13), ':') = 0 THEN ''
    ELSE substr(
      substr(`channel_thread_key`, instr(`channel_thread_key`, ':large-model:') + 13),
      instr(substr(`channel_thread_key`, instr(`channel_thread_key`, ':large-model:') + 13), ':')
    )
  END
WHERE `channel_thread_key` LIKE 'webchat:%:large-model:%';
