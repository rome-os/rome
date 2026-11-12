import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { describe, expect, it } from "@rstest/core";

const MIGRATIONS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../../drizzle/system");
const TAG = "0130_concierge_task_lifecycle";

function migrationSql(tag: string): string[] {
  return readFileSync(join(MIGRATIONS_DIR, `${tag}.sql`), "utf8")
    .split("--> statement-breakpoint")
    .map((statement) => statement.trim())
    .filter(Boolean);
}

/** A database migrated up to, but not including, the lifecycle migration. */
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

describe("the Concierge task lifecycle migration", () => {
  it("marks every row that links a task chat as linked, so it never links another", () => {
    const sqlite = databaseBeforeMigration();
    // The rows name chats this test makes no session for.
    sqlite.pragma("foreign_keys = OFF");
    const insert = sqlite.prepare(
      "INSERT INTO concierge_tasks (id, title, state, session_id, created_at, updated_at) VALUES (?, ?, 'doing', ?, ?, ?)",
    );
    insert.run("linked", "Linked", "chat-1", 1_000, 2_000);
    insert.run("planned", "Planned", null, 3_000, 3_000);

    for (const statement of migrationSql(TAG)) sqlite.exec(statement);

    expect(
      sqlite
        .prepare(
          "SELECT id, linked_at, archived_with_chat, stopped_at, stop_reason, last_outcome FROM concierge_tasks ORDER BY id",
        )
        .all(),
    ).toEqual([
      {
        id: "linked",
        linked_at: 1_000,
        archived_with_chat: 0,
        stopped_at: null,
        stop_reason: null,
        last_outcome: null,
      },
      {
        id: "planned",
        linked_at: null,
        archived_with_chat: 0,
        stopped_at: null,
        stop_reason: null,
        last_outcome: null,
      },
    ]);
    sqlite.close();
  });
});
