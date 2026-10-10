import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { describe, expect, it } from "@rstest/core";

const MIGRATIONS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../../drizzle/system");

/** The migration that strips the model selection from webchat keys, found
 *  through the journal so the test fails if nothing runs it. */
function keyMigration(): string {
  const journal = JSON.parse(readFileSync(join(MIGRATIONS_DIR, "meta/_journal.json"), "utf8")) as {
    entries: { tag: string }[];
  };
  const matches = journal.entries
    .map((entry) => readFileSync(join(MIGRATIONS_DIR, `${entry.tag}.sql`), "utf8"))
    .filter((sql) => sql.includes(":large-model:"));
  expect(matches, "exactly one migration should rewrite :large-model: keys").toHaveLength(1);
  return matches[0];
}

function applyMigration(sqlite: Database.Database, migration: string): void {
  for (const statement of migration.split("--> statement-breakpoint")) {
    if (statement.trim()) sqlite.exec(statement);
  }
}

function databaseWithRows(
  rows: { id: string; key: string; createdAt: number; status?: string; agent?: string }[],
): Database.Database {
  const sqlite = new Database(":memory:");
  sqlite.exec(`
    CREATE TABLE sessions (
      id text PRIMARY KEY NOT NULL,
      agent_name text NOT NULL,
      channel_thread_key text,
      created_at integer NOT NULL,
      last_active_at integer NOT NULL,
      status text NOT NULL
    );
  `);
  const insert = sqlite.prepare(
    "INSERT INTO sessions (id, agent_name, channel_thread_key, created_at, last_active_at, status) VALUES (?, ?, ?, ?, ?, ?)",
  );
  for (const row of rows) {
    insert.run(
      row.id,
      row.agent ?? "main",
      row.key,
      row.createdAt,
      row.createdAt,
      row.status ?? "active",
    );
  }
  return sqlite;
}

function sessionRows(sqlite: Database.Database) {
  return sqlite
    .prepare("SELECT id, channel_thread_key AS key, status FROM sessions ORDER BY id")
    .all();
}

describe("webchat thread key migration", () => {
  it("strips the model selection and keeps any suffix after it", () => {
    const sqlite = databaseWithRows([
      { id: "a", key: "webchat:chat-a:large-model:claude-opus", createdAt: 1 },
      { id: "b", key: "webchat:chat-b:large-model:gpt-5-6-sol:subagent:child-1", createdAt: 1 },
      {
        id: "c",
        key: "webchat:chat-c:large-model:auto:subagent:child-1:subagent:child-2",
        createdAt: 1,
      },
      { id: "d", key: "webchat:chat-d", createdAt: 1 },
      { id: "e", key: "telegram:large-model:x", createdAt: 1 },
    ]);
    try {
      applyMigration(sqlite, keyMigration());
      expect(sessionRows(sqlite)).toEqual([
        { id: "a", key: "webchat:chat-a", status: "active" },
        { id: "b", key: "webchat:chat-b:subagent:child-1", status: "active" },
        { id: "c", key: "webchat:chat-c:subagent:child-1:subagent:child-2", status: "active" },
        { id: "d", key: "webchat:chat-d", status: "active" },
        { id: "e", key: "telegram:large-model:x", status: "active" },
      ]);
    } finally {
      sqlite.close();
    }
  });

  it("completes all but the newest active row when two keys collapse into one", () => {
    const sqlite = databaseWithRows([
      { id: "older", key: "webchat:chat-a", createdAt: 1 },
      { id: "newer", key: "webchat:chat-a:large-model:claude-opus", createdAt: 2 },
      { id: "other-agent", key: "webchat:chat-a", createdAt: 1, agent: "helper" },
      { id: "done", key: "webchat:chat-a", createdAt: 3, status: "completed" },
    ]);
    try {
      applyMigration(sqlite, keyMigration());
      expect(sessionRows(sqlite)).toEqual([
        { id: "done", key: "webchat:chat-a", status: "completed" },
        { id: "newer", key: "webchat:chat-a", status: "active" },
        { id: "older", key: "webchat:chat-a", status: "completed" },
        { id: "other-agent", key: "webchat:chat-a", status: "active" },
      ]);
    } finally {
      sqlite.close();
    }
  });
});
