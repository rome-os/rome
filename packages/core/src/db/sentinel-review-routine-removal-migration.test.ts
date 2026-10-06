import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { describe, expect, it } from "@rstest/core";

const MIGRATIONS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../../drizzle/system");

/**
 * The migration that deletes sentinel_review routines, resolved by searching
 * the journal rather than by filename, so the test fails if nothing runs it.
 */
function removalMigration(): string {
  const journal = JSON.parse(readFileSync(join(MIGRATIONS_DIR, "meta/_journal.json"), "utf8")) as {
    entries: { tag: string }[];
  };
  const matches = journal.entries
    .map((entry) => readFileSync(join(MIGRATIONS_DIR, `${entry.tag}.sql`), "utf8"))
    .filter((sql) => /DELETE FROM `routines` WHERE `action_name` = 'sentinel_review'/.test(sql));

  expect(matches, "exactly one migration should delete sentinel_review routines").toHaveLength(1);
  return matches[0];
}

function applyMigration(sqlite: Database.Database, sql: string): void {
  for (const statement of sql.split("--> statement-breakpoint")) {
    const trimmed = statement.trim();
    if (trimmed) sqlite.exec(trimmed);
  }
}

function databaseWithRoutines(): Database.Database {
  const sqlite = new Database(":memory:");
  sqlite.pragma("foreign_keys = ON");
  sqlite.exec(`
    CREATE TABLE routines (
      id text PRIMARY KEY NOT NULL,
      action_name text NOT NULL
    );
    CREATE TABLE routine_runs (
      id text PRIMARY KEY NOT NULL,
      routine_id text NOT NULL,
      FOREIGN KEY (routine_id) REFERENCES routines(id)
    );
  `);

  const routine = sqlite.prepare("INSERT INTO routines (id, action_name) VALUES (?, ?)");
  routine.run("sentinel", "sentinel_review");
  routine.run("upgrade", "system_upgrade");

  const run = sqlite.prepare("INSERT INTO routine_runs (id, routine_id) VALUES (?, ?)");
  run.run("sentinel-run-1", "sentinel");
  run.run("sentinel-run-2", "sentinel");
  run.run("upgrade-run", "upgrade");

  return sqlite;
}

function ids(sqlite: Database.Database, table: string): string[] {
  return sqlite
    .prepare(`SELECT id FROM ${table} ORDER BY id`)
    .all()
    .map((row) => (row as { id: string }).id);
}

describe("sentinel_review routine removal migration", () => {
  it("deletes sentinel_review routines and their runs, and keeps every other routine", () => {
    const sqlite = databaseWithRoutines();
    try {
      applyMigration(sqlite, removalMigration());

      expect(ids(sqlite, "routines")).toEqual(["upgrade"]);
      expect(ids(sqlite, "routine_runs")).toEqual(["upgrade-run"]);
    } finally {
      sqlite.close();
    }
  });
});
