import { sql } from "drizzle-orm";
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

/**
 * Whether a failure's error text is shown: started by the guardian, or by one
 * of their routines. Anything else, such as a visitor, an anonymous viewer, or
 * an agent turn answering someone on Rome's accounts (no actor), can echo what
 * someone else wrote. Event-triggered routines are included and can still
 * quote an inbound payload, so Dream's practice prompt reads every error
 * message as data.
 */
function trustedError(actor: string | null, initiator: string | null): boolean {
  if (actor) {
    try {
      return (JSON.parse(actor) as { kind?: string }).kind === "guardian";
    } catch {
      return false;
    }
  }
  return initiator?.startsWith("routine:") ?? false;
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
      // Dream's practice agent reads these logs with Bash, so an untrusted
      // failure shows that it happened, not its text.
      const text = trustedError(errRow.actor, errRow.initiator)
        ? errRow.error
        : "(error text hidden)";
      lines.push(`- **[${time}] ERROR${who ? ` (by ${who})` : ""}:** ${text}`);
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
        const nameCondition = actionNameFilter ? sql`AND action_name = ${actionNameFilter}` : sql``;
        rows = appContext.db.connection.all(
          sql`
            SELECT id, action_name, action_type, status, args, error, duration_ms, initiator, actor, started_at, finished_at
            FROM action_executions
            WHERE started_at >= ${cutoffSeconds}
              ${nameCondition}
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
