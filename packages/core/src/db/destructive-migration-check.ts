// Rollback-safety check for system migrations. The rule it enforces, and the
// two-release sequence that satisfies it, are in DEVELOPMENT.md under
// "Established patterns". The CLI that feeds it from git lives in
// src/bin/check-destructive-migrations.ts.
import Database from "better-sqlite3";

/** The part of a drizzle-kit snapshot (`meta/NNNN_snapshot.json`) the check reads. */
export interface SchemaSnapshot {
  tables: Record<string, { columns: Record<string, unknown> }>;
}

export interface MigrationSql {
  /** The migration's journal tag, e.g. `0072_drop_provider_accounts`. */
  name: string;
  sql: string;
  /** True when the last release's journal lists the migration. */
  shipped: boolean;
}

/** A table, or a column when `column` is set, that the last release declares and a later migration removes. */
export interface DeclaredRemoval {
  table: string;
  column?: string;
  /** The unshipped migration that removed it. */
  migration: string;
}

/**
 * Lists every table and column that the last release's schema declares and
 * that the migrations it did not ship remove.
 *
 * The migrations run on an in-memory SQLite database the way drizzle's
 * migrator runs them: the shipped ones first, then each unshipped one. The
 * schema SQLite reports after each step is compared with the snapshot, so a
 * drop, a rename, or a rebuild that leaves a column out all count, however the
 * SQL is written. An object removed and created again by a later migration
 * counts as kept. A declared object the shipped migrations never created is
 * ignored, since it never existed for a reader to need.
 *
 * Throws when a migration fails to run, naming it.
 */
export function findDeclaredRemovals(input: {
  shippedSnapshot: SchemaSnapshot;
  migrations: readonly MigrationSql[];
}): DeclaredRemoval[] {
  const db = new Database(":memory:");
  try {
    for (const migration of input.migrations) {
      if (migration.shipped) applyMigration(db, migration);
    }
    let present = readSchema(db);
    const declared = declaredObjects(input.shippedSnapshot).filter((object) =>
      exists(present, object),
    );

    const removedBy = new Map<DeclaredObject, string>();
    for (const migration of input.migrations) {
      if (migration.shipped) continue;
      applyMigration(db, migration);
      const after = readSchema(db);
      for (const object of declared) {
        if (exists(present, object) && !exists(after, object))
          removedBy.set(object, migration.name);
      }
      present = after;
    }

    const removals: DeclaredRemoval[] = [];
    for (const object of declared) {
      const migration = removedBy.get(object);
      if (migration === undefined || exists(present, object)) continue;
      // A removed table reports once, not once per column.
      if (object.column !== undefined && !present.has(object.table.toLowerCase())) continue;
      removals.push(
        object.column === undefined
          ? { table: object.table, migration }
          : { table: object.table, column: object.column, migration },
      );
    }
    return removals;
  } finally {
    db.close();
  }
}

interface DeclaredObject {
  table: string;
  column?: string;
}

function declaredObjects(snapshot: SchemaSnapshot): DeclaredObject[] {
  return Object.entries(snapshot.tables).flatMap(([table, { columns }]) => [
    { table },
    ...Object.keys(columns).map((column) => ({ table, column })),
  ]);
}

/** Table name to its column names, all lower-cased, since SQLite matches names case-insensitively. */
type PhysicalSchema = Map<string, Set<string>>;

function exists(schema: PhysicalSchema, object: DeclaredObject): boolean {
  const columns = schema.get(object.table.toLowerCase());
  if (!columns) return false;
  return object.column === undefined || columns.has(object.column.toLowerCase());
}

function readSchema(db: Database.Database): PhysicalSchema {
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as {
    name: string;
  }[];
  return new Map(
    tables.map(({ name }) => {
      const columns = db.pragma(`table_info("${name.replaceAll('"', '""')}")`) as {
        name: string;
      }[];
      return [name.toLowerCase(), new Set(columns.map((column) => column.name.toLowerCase()))];
    }),
  );
}

// Mirrors drizzle's SQLite migrator, which splits a migration on its
// breakpoints and runs each piece as one statement.
function applyMigration(db: Database.Database, migration: MigrationSql): void {
  for (const statement of migration.sql.split("--> statement-breakpoint")) {
    try {
      db.prepare(statement).run();
    } catch (err) {
      throw new Error(
        `migration ${migration.name} failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}
