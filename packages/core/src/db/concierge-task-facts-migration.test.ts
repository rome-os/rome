import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { describe, expect, it } from "@rstest/core";

const MIGRATIONS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../../drizzle/system");
const TAG = "0131_concierge_task_facts";

function migrationSql(tag: string): string[] {
  return readFileSync(join(MIGRATIONS_DIR, `${tag}.sql`), "utf8")
    .split("--> statement-breakpoint")
    .map((statement) => statement.trim())
    .filter(Boolean);
}

/** A database migrated up to, but not including, the facts migration. */
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

describe("the Concierge task facts migration", () => {
  it("turns each state the Concierge wrote into the facts it stood for", () => {
    const sqlite = databaseBeforeMigration();
    const insert = sqlite.prepare(
      "INSERT INTO concierge_tasks (id, title, state, due_at, completed_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 1, 2)",
    );
    insert.run("done", "Done", "done", null, 50);
    insert.run("dropped", "Dropped", "dropped", null, 60);
    insert.run("next-timed", "Planned", "next", 9_000, null);
    insert.run("next-bare", "Someday", "next", null, null);
    insert.run("watching-bare", "Watched", "watching", null, null);
    insert.run("doing", "Doing", "doing", null, null);
    insert.run("asks", "Asks", "needs_user", null, null);

    for (const statement of migrationSql(TAG)) sqlite.exec(statement);

    expect(
      sqlite
        .prepare(
          "SELECT id, last_outcome, stopped_at, stop_reason, note FROM concierge_tasks ORDER BY id",
        )
        .all(),
    ).toEqual([
      { id: "asks", last_outcome: null, stopped_at: null, stop_reason: null, note: null },
      { id: "doing", last_outcome: null, stopped_at: null, stop_reason: null, note: null },
      { id: "done", last_outcome: "succeeded", stopped_at: null, stop_reason: null, note: null },
      { id: "dropped", last_outcome: null, stopped_at: 60, stop_reason: "concierge", note: null },
      {
        id: "next-bare",
        last_outcome: "succeeded",
        stopped_at: null,
        stop_reason: null,
        note: null,
      },
      { id: "next-timed", last_outcome: null, stopped_at: null, stop_reason: null, note: null },
      {
        id: "watching-bare",
        last_outcome: "succeeded",
        stopped_at: null,
        stop_reason: null,
        note: null,
      },
    ]);
    sqlite.close();
  });
});
