import { sql, type SQL } from "drizzle-orm";

/** Invalid JSON and legacy rows are unflagged. Only a JSON boolean opts in. */
export function isolatedSession(metadata: SQL): SQL {
  return sql`CASE WHEN json_valid(${metadata})
    THEN COALESCE(json_type(${metadata}, '$.isolated') = 'true', 0)
    ELSE 0 END`;
}

/** Session provenance includes the execution's parent chain and root, even for legacy children. */
export function actionSessionIds(actionAlias: SQL): SQL {
  return sql`WITH RECURSIVE executions(id, parent_id, root_execution_id, session_id) AS (
    SELECT id, parent_id, root_execution_id, session_id FROM action_executions
    WHERE id = ${actionAlias}.id
    UNION
    SELECT parent.id, parent.parent_id, parent.root_execution_id, parent.session_id
    FROM action_executions parent JOIN executions child
      ON parent.id = child.parent_id OR parent.id = child.root_execution_id
  )
  SELECT session_id FROM executions WHERE session_id IS NOT NULL`;
}
