import { sqliteTable, text } from "drizzle-orm/sqlite-core";

/**
 * Chief of staff data model. Two documents the team owns and returns to: the
 * roster and the goals document. Each is one row, keyed by its name, holding
 * the document as the team wrote it. Logical names only; the daemon joins the
 * `chief_of_staff__` prefix.
 */
export function createAppDbSchema(tablePrefix = "chief_of_staff") {
  // One owned document, "roster" or "goals", as markdown. The agent reads it
  // through read_team and cites it by name as a source.
  const documents = sqliteTable(`${tablePrefix}__documents`, {
    /** "roster" or "goals". */
    name: text("name").primaryKey(),
    /** The document as the team wrote it, markdown. */
    body: text("body").notNull().default(""),
    updatedAt: text("updated_at").notNull(),
  });

  return { documents };
}

export type AppDbSchema = ReturnType<typeof createAppDbSchema>;

// The default-prefix tables drizzle-kit reads to generate migrations.
const defaultSchema = createAppDbSchema();

export const documents = defaultSchema.documents;
