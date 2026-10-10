-- A chat can have a stray active `webchat:<id>` row beside the selected-model
-- row its turns actually used (an old defer resume opened one). Complete the
-- stray row first, so the rewrite below leaves the live row in charge.
UPDATE `sessions`
SET `status` = 'completed'
WHERE `status` = 'active'
  AND `channel_thread_key` LIKE 'webchat:%'
  AND instr(`channel_thread_key`, ':large-model:') = 0
  AND EXISTS (
    SELECT 1 FROM `sessions` AS `selected`
    WHERE `selected`.`status` = 'active'
      AND `selected`.`agent_name` = `sessions`.`agent_name`
      AND substr(`selected`.`channel_thread_key`, 1, length(`sessions`.`channel_thread_key`) + 13)
        = `sessions`.`channel_thread_key` || ':large-model:'
      AND instr(substr(`selected`.`channel_thread_key`, length(`sessions`.`channel_thread_key`) + 14), ':') = 0
  );
--> statement-breakpoint
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
--> statement-breakpoint
-- Any other rows that now share an active key keep the one the session
-- lookup picks (newest created_at, then last_active_at) and complete the rest.
UPDATE `sessions`
SET `status` = 'completed'
WHERE `status` = 'active'
  AND `channel_thread_key` LIKE 'webchat:%'
  AND EXISTS (
    SELECT 1 FROM `sessions` AS `newer`
    WHERE `newer`.`status` = 'active'
      AND `newer`.`agent_name` = `sessions`.`agent_name`
      AND `newer`.`channel_thread_key` = `sessions`.`channel_thread_key`
      AND (
        `newer`.`created_at` > `sessions`.`created_at`
        OR (`newer`.`created_at` = `sessions`.`created_at` AND `newer`.`last_active_at` > `sessions`.`last_active_at`)
        OR (`newer`.`created_at` = `sessions`.`created_at` AND `newer`.`last_active_at` = `sessions`.`last_active_at` AND `newer`.`id` > `sessions`.`id`)
      )
  );
