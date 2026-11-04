import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { describe, expect, it } from "@rstest/core";

const MIGRATIONS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../../drizzle/system");
const TAG = "0112_follow_items_important";

function migrationSql(tag: string): string[] {
  return readFileSync(join(MIGRATIONS_DIR, `${tag}.sql`), "utf8")
    .split("--> statement-breakpoint")
    .map((statement) => statement.trim())
    .filter(Boolean);
}

/** A database migrated up to, but not including, the rename. */
function databaseBeforeMigration(): Database.Database {
  const journal = JSON.parse(readFileSync(join(MIGRATIONS_DIR, "meta/_journal.json"), "utf8")) as {
    entries: { tag: string }[];
  };
  const tags = journal.entries.map((entry) => entry.tag);
  expect(tags).toContain(TAG);
  const sqlite = new Database(":memory:");
  for (const tag of tags.slice(0, tags.indexOf(TAG))) {
    for (const statement of migrationSql(tag)) sqlite.exec(statement);
  }
  return sqlite;
}

describe("the follow items important migration", () => {
  it("moves rows stored as notify to important, and leaves digest rows", () => {
    const sqlite = databaseBeforeMigration();
    const insert = sqlite.prepare(
      "INSERT INTO concierge_follow_items (id, event_id, source, kind, target, decision, reason, line, created_at) VALUES (?, ?, 'github', 'your_ci_failed', 'acme/widgets', ?, 'r', 'l', 1)",
    );
    insert.run("a", "e1", "notify");
    insert.run("b", "e2", "digest");

    for (const statement of migrationSql(TAG)) sqlite.exec(statement);

    expect(
      sqlite.prepare("SELECT id, decision FROM concierge_follow_items ORDER BY id").all(),
    ).toEqual([
      { id: "a", decision: "important" },
      { id: "b", decision: "digest" },
    ]);
    sqlite.close();
  });
});
