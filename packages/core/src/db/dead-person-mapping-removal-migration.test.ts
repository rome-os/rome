import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { describe, expect, it } from "@rstest/core";

const MIGRATIONS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../../drizzle/system");
const TAG = "0114_remove_dead_person_mapping";

function migrationSql(tag: string): string[] {
  return readFileSync(join(MIGRATIONS_DIR, `${tag}.sql`), "utf8")
    .split("--> statement-breakpoint")
    .map((statement) => statement.trim())
    .filter(Boolean);
}

/** A database migrated up to, but not including, this migration. */
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

const personColumns = (sqlite: Database.Database) =>
  (sqlite.prepare("PRAGMA table_info(persons)").all() as { name: string }[]).map(
    (column) => column.name,
  );

describe("the dead person_mapping removal migration", () => {
  it("deletes every person_mapping approval and keeps the other kinds", () => {
    const sqlite = databaseBeforeMigration();
    const approval = sqlite.prepare(
      "INSERT INTO approvals (id, type, status, requested_by, description, payload, created_at) VALUES (?, ?, ?, 'x', 'y', ?, 1)",
    );
    approval.run("pairing", "person_mapping", "pending", '{"action":"channel_pairing"}');
    approval.run("agent-link", "person_mapping", "pending", '{"personId":"p1"}');
    approval.run("action", "action_execution", "pending", null);
    approval.run("sent", "outgoing_message", "auto_approved", null);

    for (const statement of migrationSql(TAG)) sqlite.exec(statement);

    expect(
      sqlite
        .prepare("SELECT id FROM approvals ORDER BY id")
        .all()
        .map((row) => (row as { id: string }).id),
    ).toEqual(["action", "sent"]);
    sqlite.close();
  });

  it("drops a person's approved flag and keeps the person", () => {
    const sqlite = databaseBeforeMigration();
    expect(personColumns(sqlite)).toContain("approved");
    sqlite
      .prepare(
        "INSERT INTO persons (id, display_name, bond_level, approved, created_at) VALUES ('p1', 'Ray', 'acquaintance', 0, 1)",
      )
      .run();

    for (const statement of migrationSql(TAG)) sqlite.exec(statement);

    expect(personColumns(sqlite)).not.toContain("approved");
    expect(sqlite.prepare("SELECT id, display_name FROM persons").all()).toEqual([
      { id: "p1", display_name: "Ray" },
    ]);
    sqlite.close();
  });
});
