-- A check the Concierge scheduled for a task named it `task:<id>`. It now
-- names its task in its args, so the task reads its "later" time from it and
-- stopping the task cancels it. Only a pending wake-up of a Concierge chat
-- whose name holds the id of an existing task is touched.
UPDATE `routines`
  SET `args` = json_set(`args`, '$.taskId', substr(`name`, instr(`name`, 'task:') + 5, 36))
  WHERE `action_name` = 'resume_session'
    AND `enabled` = 1
    AND json_extract(`args`, '$.agentName') = 'core:concierge'
    AND json_extract(`args`, '$.taskId') IS NULL
    AND instr(`name`, 'task:') > 0
    AND substr(`name`, instr(`name`, 'task:') + 5, 36) IN (SELECT `id` FROM `concierge_tasks`);
