import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { describe, expect, it } from "@rstest/core";
import { mainChatIdOf } from "../webchat/owner.js";

const MIGRATIONS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../../drizzle/system");
const TAG = "0126_main_chat_name";

function migrationSql(tag: string): string[] {
  return readFileSync(join(MIGRATIONS_DIR, `${tag}.sql`), "utf8")
    .split("--> statement-breakpoint")
    .map((statement) => statement.trim())
    .filter(Boolean);
}

/** A database migrated up to, but not including, the main chat name migration. */
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

describe("the main chat name migration", () => {
  it("renames a main chat still called Concierge, and nothing else", () => {
    const sqlite = databaseBeforeMigration();
    const visitorMain = mainChatIdOf("visitor:acct-ann");
    const chats: [id: string, name: string][] = [
      ["concierge", "Concierge"],
      [visitorMain, "Concierge"],
      // A main chat its owner renamed.
      [mainChatIdOf("visitor:acct-bob"), "Bob's desk"],
      // A topic chat or a common chat that happens to be called Concierge.
      ["topic-1", "Concierge"],
      ["concierge-v-notamainchat", "Concierge"],
    ];
    const insert = sqlite.prepare(
      `INSERT INTO rome_sessions
        (id, name, project_name, type, source_channel, agent_name, created_at, activity_at)
       VALUES (?, ?, 'default', 'channel', 'webchat', 'core:concierge', 0, 0)`,
    );
    for (const [id, name] of chats) insert.run(id, name);

    for (const statement of migrationSql(TAG)) sqlite.exec(statement);

    const names = Object.fromEntries(
      (
        sqlite.prepare("SELECT id, name FROM rome_sessions").all() as { id: string; name: string }[]
      ).map((row) => [row.id, row.name]),
    );
    expect(names).toEqual({
      concierge: "Main chat",
      [visitorMain]: "Main chat",
      [mainChatIdOf("visitor:acct-bob")]: "Bob's desk",
      "topic-1": "Concierge",
      "concierge-v-notamainchat": "Concierge",
    });
    sqlite.close();
  });
});
