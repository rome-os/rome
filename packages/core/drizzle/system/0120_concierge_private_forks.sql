-- A fork of a Concierge chat or a Concierge task chat is private to that
-- chat's owner. Forks made before they were stamped at creation get the same
-- stamp now, while the chats they came from still exist, so deleting one later
-- never makes its forks open. `line` walks each fork's parents, at most eight,
-- and stops at the first private one. A null column never counts as private.
WITH RECURSIVE line(id, ancestor, depth) AS (
  SELECT `id`, `parent_session_id`, 1 FROM `rome_sessions` WHERE `parent_session_id` IS NOT NULL
  UNION ALL
  SELECT line.id, p.`parent_session_id`, line.depth + 1
  FROM line JOIN `rome_sessions` p ON p.`id` = line.ancestor
  WHERE p.`parent_session_id` IS NOT NULL
    AND line.depth < 8
    AND NOT (
      p.`id` = 'concierge'
      OR coalesce(p.`agent_name`, '') IN ('core:concierge', 'concierge')
      OR coalesce(p.`trigger_kind`, '') IN ('concierge', 'concierge_fork')
    )
),
private_line AS (
  SELECT line.id AS id, a.`owner_key` AS owner_key, line.depth AS depth
  FROM line JOIN `rome_sessions` a ON a.`id` = line.ancestor
  WHERE a.`id` = 'concierge'
    OR coalesce(a.`agent_name`, '') IN ('core:concierge', 'concierge')
    OR coalesce(a.`trigger_kind`, '') IN ('concierge', 'concierge_fork')
)
UPDATE `rome_sessions`
SET `trigger_kind` = 'concierge_fork',
  `owner_key` = (
    SELECT private_line.owner_key FROM private_line
    WHERE private_line.id = `rome_sessions`.`id`
    ORDER BY private_line.depth LIMIT 1
  )
WHERE `id` IN (SELECT id FROM private_line)
  AND `id` <> 'concierge'
  AND coalesce(`agent_name`, '') NOT IN ('core:concierge', 'concierge')
  AND coalesce(`trigger_kind`, '') NOT IN ('concierge', 'concierge_fork');
