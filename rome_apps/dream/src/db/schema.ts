import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

/**
 * Dream data model: one row per run of the `dream` or `skill_review` action,
 * and one row per file change its agent made. Logical names only; the daemon
 * joins the `dream__` prefix.
 */
export function createAppDbSchema(tablePrefix: string = "dream") {
  const runs = sqliteTable(
    `${tablePrefix}__runs`,
    {
      id: text("id").primaryKey(),
      /** "dream" | "skill_review" */
      kind: text("kind").notNull(),
      /** "running" | "completed" | "failed" */
      status: text("status").notNull(),
      /** Hours of history a dream reviewed. Null for a skill review. */
      windowHours: integer("window_hours"),
      /** The webchat session a skill review read. Null for a dream. */
      reviewedSessionId: text("reviewed_session_id"),
      /** Snapshot of that session's name, so the run reads after a rename or delete. */
      reviewedSessionName: text("reviewed_session_name"),
      /** The agent's final message. */
      summary: text("summary"),
      error: text("error"),
      startedAt: integer("started_at", { mode: "timestamp_ms" }).notNull(),
      finishedAt: integer("finished_at", { mode: "timestamp_ms" }),
    },
    (t) => [index(`${tablePrefix}__runs_started_idx`).on(t.startedAt)],
  );

  const runChanges = sqliteTable(
    `${tablePrefix}__run_changes`,
    {
      id: text("id").primaryKey(),
      runId: text("run_id").notNull(),
      /** Order within the run. */
      seq: integer("seq").notNull(),
      /** "write" | "edit" */
      op: text("op").notNull(),
      path: text("path").notNull(),
      content: text("content").notNull(),
      previous: text("previous"),
      truncated: integer("truncated", { mode: "boolean" }).notNull().default(false),
      createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    },
    (t) => [index(`${tablePrefix}__run_changes_run_idx`).on(t.runId, t.seq)],
  );

  return { runs, runChanges };
}

const defaultSchema = createAppDbSchema();

export const runs = defaultSchema.runs;
export const runChanges = defaultSchema.runChanges;
