// The 0106 migration recreates two of Chats' empty tables WITHOUT ROWID. Like
// every migration test, it writes the columns that schema had.

import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { describe, expect, it } from "@rstest/core";

const MIGRATIONS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../../drizzle/system");
const TAG = "0106_chats_tables_without_rowid";

function migrationSql(tag: string): string[] {
  return readFileSync(join(MIGRATIONS_DIR, `${tag}.sql`), "utf8")
    .split("--> statement-breakpoint")
    .map((statement) => statement.trim())
    .filter(Boolean);
}

/** A database migrated up to, but not including, `tag`, with foreign keys
 *  on, as Rome migrates at boot. */
function databaseBefore(tag: string): Database.Database {
  const journal = JSON.parse(readFileSync(join(MIGRATIONS_DIR, "meta/_journal.json"), "utf8")) as {
    entries: { tag: string }[];
  };
  const tags = journal.entries.map((entry) => entry.tag);
  const sqlite = new Database(":memory:");
  sqlite.pragma("foreign_keys = ON");
  for (const earlier of tags.slice(0, tags.indexOf(tag))) {
    for (const statement of migrationSql(earlier)) sqlite.exec(statement);
  }
  return sqlite;
}

/** Apply `tag` in one transaction, as Rome's migrator does. */
function migrate(sqlite: Database.Database) {
  sqlite.transaction(() => {
    for (const statement of migrationSql(TAG)) sqlite.exec(statement);
  })();
}

const tableSql = (sqlite: Database.Database, name: string) =>
  (
    sqlite.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) as {
      sql: string;
    }
  ).sql;

describe("0106_chats_tables_without_rowid", () => {
  it("recreate the turn links and chat addresses WITHOUT ROWID, keeping their keys and indexes", () => {
    const sqlite = databaseBefore(TAG);
    sqlite.exec(
      `INSERT INTO chats (id, platform, key, kind, started_at) VALUES (1, 'telegram', '-1', 'group', 0)`,
    );

    migrate(sqlite);

    expect(tableSql(sqlite, "agent_turn_messages")).toMatch(/\) WITHOUT ROWID$/);
    expect(tableSql(sqlite, "chat_addresses")).toMatch(/\) WITHOUT ROWID$/);
    const indexes = sqlite
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'index' AND name IN (?, ?) ORDER BY name",
      )
      .all("idx_agent_turn_messages_turn", "idx_chat_addresses_address");
    expect(indexes).toHaveLength(2);
    expect(sqlite.pragma("foreign_key_check")).toEqual([]);

    sqlite.exec(`
      INSERT INTO chat_messages (id, chat_id, key, text, parts, said_at)
        VALUES (5, 1, 'm5', 'hi', '[]', 0);
      INSERT INTO agent_turn_messages (message_id, session_id, role) VALUES (5, 'seat-1', 'seen');
      INSERT INTO chat_addresses (platform, account_id, chat_key, address)
        VALUES ('telegram', 'bot', 'dm:bot:alice', 'alice');
    `);
    expect(() =>
      sqlite.exec(
        `INSERT INTO agent_turn_messages (message_id, session_id, role) VALUES (5, 'seat-1', 'seen')`,
      ),
    ).toThrow(/UNIQUE/);
    // A turn link still goes with its message.
    sqlite.exec("DELETE FROM chat_messages WHERE id = 5");
    expect(sqlite.prepare("SELECT count(*) AS n FROM agent_turn_messages").get()).toEqual({ n: 0 });
  });
});
