import { sql } from "drizzle-orm";
import { actionSessionIds, isolatedSession } from "../../lib/session-privacy.js";
import {
  createAppLogger,
  type Action,
  type ActionConfig,
  type ActionResult,
  type AppActionRuntimeDeps,
} from "@rome-os/app-runtime";

const log = createAppLogger("get_action_logs");

interface ActionExecutionRow {
  id: string;
  action_name: string;
  action_type: string | null;
  status: string;
  args: string | null;
  error: string | null;
  duration_ms: number | null;
  initiator: string | null;
  /** JSON-encoded SessionActor (guardian/visitor/anonymous), or null. */
  actor: string | null;
  started_at: number;
  finished_at: number | null;
}

function actorLabel(raw: string | null): string | null {
  if (!raw) return null;
  try {
    const actor = JSON.parse(raw) as { kind?: string; email?: string; accountId?: string };
    if (actor.kind === "guardian") return actor.email ? `guardian ${actor.email}` : "guardian";
    if (actor.kind === "visitor") return actor.email ?? actor.accountId ?? "visitor";
    if (actor.kind === "anonymous") return "anonymous";
    return null;
  } catch {
    return null;
  }
}

function formatActionLogs(rows: ActionExecutionRow[]): string {
  if (rows.length === 0) {
    return "(No action executions found in the requested window.)";
  }

  // Group by action_name for summary
  const byAction = new Map<
    string,
    { success: number; error: number; rows: ActionExecutionRow[] }
  >();
  for (const row of rows) {
    let entry = byAction.get(row.action_name);
    if (!entry) {
      entry = { success: 0, error: 0, rows: [] };
      byAction.set(row.action_name, entry);
    }
    if (row.status === "success") entry.success++;
    else if (row.status === "error") entry.error++;
    entry.rows.push(row);
  }

  const lines: string[] = [`**Total executions:** ${rows.length}\n`];

  for (const [actionName, entry] of byAction) {
    const statusParts: string[] = [];
    if (entry.success > 0) statusParts.push(`${entry.success} succeeded`);
    if (entry.error > 0) statusParts.push(`${entry.error} failed`);
    const other = entry.rows.length - entry.success - entry.error;
    if (other > 0) statusParts.push(`${other} other`);

    lines.push(`### \`${actionName}\` — ${statusParts.join(", ")}`);

    // Show errors inline
    const errors = entry.rows.filter((r) => r.status === "error" && r.error);
    for (const errRow of errors) {
      const time = new Date(errRow.started_at * 1000).toISOString();
      const who = actorLabel(errRow.actor);
      lines.push(`- **[${time}] ERROR${who ? ` (by ${who})` : ""}:** ${errRow.error}`);
    }

    lines.push("");
  }

  return lines.join("\n");
}

export function createAction(config: ActionConfig, deps: AppActionRuntimeDeps): Action {
  const { appContext } = deps;

  return {
    config,
    inputSchema: {
      type: "object",
      properties: {
        windowHours: {
          type: "number",
          description: "How many hours back to fetch action logs (default: 24)",
        },
        actionName: {
          type: "string",
          description: "Optional: filter to a specific action name",
        },
      },
      required: [],
    },

    async execute(args): Promise<ActionResult> {
      const windowHours = (args.windowHours as number | undefined) ?? 24;
      const actionNameFilter = args.actionName as string | undefined;
      const cutoffSeconds = Math.floor((Date.now() - windowHours * 60 * 60 * 1000) / 1000);

      log.info("fetching action logs", { windowHours, actionNameFilter });

      let rows: ActionExecutionRow[] = [];
      try {
        const nameCondition = actionNameFilter
          ? sql`AND ae.action_name = ${actionNameFilter}`
          : sql``;
        rows = appContext.db.connection.all(
          sql`
            SELECT id, action_name, action_type, status, args, error, duration_ms, initiator, actor, started_at, finished_at
            FROM action_executions ae
            WHERE started_at >= ${cutoffSeconds}
              ${nameCondition}
              AND NOT EXISTS (
                WITH RECURSIVE lineage(id, parent_session_id, metadata_json) AS (
                  SELECT id, parent_session_id, metadata_json FROM rome_sessions
                  WHERE id IN (${actionSessionIds(sql`ae`)})
                  UNION
                  SELECT parent.id, parent.parent_session_id, parent.metadata_json
                  FROM rome_sessions parent JOIN lineage child ON parent.id = child.parent_session_id
                )
                SELECT 1 FROM lineage WHERE ${isolatedSession(sql`metadata_json`)}
              )
              AND NOT EXISTS (
                SELECT 1 FROM rome_sessions isolated
                WHERE ${isolatedSession(sql`isolated.metadata_json`)}
                  AND CASE WHEN json_valid(isolated.metadata_json)
                    THEN json_type(isolated.metadata_json, '$.appId') = 'text'
                      AND length(json_extract(isolated.metadata_json, '$.appId')) > 0
                      AND substr(ae.action_name, 1, length(json_extract(isolated.metadata_json, '$.appId')) + 1)
                        = json_extract(isolated.metadata_json, '$.appId') || ':'
                    ELSE 0 END
                  AND NOT EXISTS (
                    SELECT 1 FROM rome_sessions
                    WHERE id IN (${actionSessionIds(sql`ae`)})
                  )
              )
              AND NOT (
                ae.action_name = 'system:send_user_message'
                AND CASE WHEN json_valid(ae.args) THEN
                  COALESCE(json_type(ae.args, '$.sessionMetadata.isolated') = 'true', 0)
                  OR EXISTS (
                    SELECT 1 FROM rome_sessions target
                    WHERE target.id = json_extract(ae.args, '$.sessionId')
                      AND ${isolatedSession(sql`target.metadata_json`)}
                  )
                ELSE 0 END
              )
            ORDER BY started_at ASC
          `,
        ) as ActionExecutionRow[];
      } catch (err) {
        log.error("failed to query action executions", {
          error: err instanceof Error ? err.message : String(err),
        });
        return {
          status: "error",
          error: `Failed to query action executions: ${err instanceof Error ? err.message : String(err)}`,
        };
      }

      log.info("fetched action executions", { count: rows.length, windowHours });

      const windowStart = new Date(cutoffSeconds * 1000).toISOString();
      const windowEnd = new Date().toISOString();
      const header = `## Action Execution Logs (${windowStart} → ${windowEnd})\n\n`;
      const body = formatActionLogs(rows);

      return {
        status: "ok",
        data: {
          executionCount: rows.length,
          windowHours,
          content: header + body,
        },
      };
    },
  };
}
