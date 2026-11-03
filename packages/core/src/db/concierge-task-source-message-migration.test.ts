import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { describe, expect, it } from "@rstest/core";

const MIGRATIONS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../../drizzle/system");
const TAG = "0104_concierge_task_source_message";

function migrationSql(tag: string): string[] {
  return readFileSync(join(MIGRATIONS_DIR, `${tag}.sql`), "utf8")
    .split("--> statement-breakpoint")
    .map((statement) => statement.trim())
    .filter(Boolean);
}

/** A database migrated up to, but not including, the source message migration. */
function databaseBeforeMigration(): Database.Database {
  const journal = JSON.parse(readFileSync(join(MIGRATIONS_DIR, "meta/_journal.json"), "utf8")) as {
    entries: { tag: string }[];
  };
  const tags = journal.entries.map((entry) => entry.tag);
  expect(tags).toContain(TAG);
  const sqlite = new Database(":memory:");
  sqlite.pragma("foreign_keys = ON");
  for (const tag of tags.slice(0, tags.indexOf(TAG))) {
    for (const statement of migrationSql(tag)) sqlite.exec(statement);
  }
  return sqlite;
}

const columns = (sqlite: Database.Database) =>
  (sqlite.prepare("PRAGMA table_info(concierge_tasks)").all() as { name: string }[]).map(
    (column) => column.name,
  );

describe("the Concierge task source message migration", () => {
  it("adds a nullable column and leaves existing rows without a source message", () => {
    const sqlite = databaseBeforeMigration();
    expect(columns(sqlite)).not.toContain("source_message_id");
    sqlite
      .prepare(
        "INSERT INTO concierge_tasks (id, title, state, created_at, updated_at) VALUES ('old', 'Old row', 'next', 1, 1)",
      )
      .run();

    for (const statement of migrationSql(TAG)) sqlite.exec(statement);

    expect(columns(sqlite)).toContain("source_message_id");
    expect(
      sqlite.prepare("SELECT id, title, source_message_id FROM concierge_tasks").all(),
    ).toEqual([{ id: "old", title: "Old row", source_message_id: null }]);
    sqlite.close();
  });

  it("takes any message id, since the column holds no foreign key", () => {
    const sqlite = databaseBeforeMigration();
    for (const statement of migrationSql(TAG)) sqlite.exec(statement);
    sqlite
      .prepare(
        "INSERT INTO concierge_tasks (id, title, state, source_message_id, created_at, updated_at) VALUES ('new', 'New row', 'next', 'no-such-message', 1, 1)",
      )
      .run();
    expect(
      sqlite.prepare("SELECT source_message_id FROM concierge_tasks WHERE id = 'new'").get(),
    ).toEqual({ source_message_id: "no-such-message" });
    sqlite.close();
  });
});
