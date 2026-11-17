import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { describe, expect, it } from "@rstest/core";

const MIGRATIONS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../../drizzle/system");
const TAG = "0144_message_read_at";

function migrationSql(tag: string): string[] {
  return readFileSync(join(MIGRATIONS_DIR, `${tag}.sql`), "utf8")
    .split("--> statement-breakpoint")
    .map((statement) => statement.trim())
    .filter(Boolean);
}

describe("the message read-at migration", () => {
  it("adds read_at with every existing message read when it was said", () => {
    const journal = JSON.parse(
      readFileSync(join(MIGRATIONS_DIR, "meta/_journal.json"), "utf8"),
    ) as { entries: { tag: string }[] };
    const tags = journal.entries.map((entry) => entry.tag);
    expect(tags).toContain(TAG);
    const sqlite = new Database(":memory:");
    for (const tag of tags.slice(0, tags.indexOf(TAG))) {
      for (const statement of migrationSql(tag)) sqlite.exec(statement);
    }
    sqlite.exec(
      "INSERT INTO chats (platform, key, kind, started_at) VALUES ('webchat', 'concierge', 'dm', 1)",
    );
    const insert = sqlite.prepare(
      "INSERT INTO chat_messages (chat_id, key, sender_account_id, sender_agent, text, parts, said_at) VALUES (1, ?, ?, ?, ?, '[]', ?)",
    );
    insert.run("u1", "guardian", null, "Hello", 100);
    insert.run("a1", "agent:main", "main", "Hi", 200);

    for (const statement of migrationSql(TAG)) sqlite.exec(statement);

    expect(
      sqlite.prepare("SELECT key, said_at AS saidAt, read_at AS readAt FROM chat_messages").all(),
    ).toEqual([
      { key: "u1", saidAt: 100, readAt: 100 },
      { key: "a1", saidAt: 200, readAt: 200 },
    ]);

    // A message recorded afterwards starts unread.
    insert.run("a2", "agent:main", "main", "Later", 300);
    expect(
      sqlite.prepare("SELECT read_at AS readAt FROM chat_messages WHERE key = 'a2'").get(),
    ).toEqual({ readAt: null });
  });

  it("leaves every existing message its own chat thread, keeping what it replies to", () => {
    const journal = JSON.parse(
      readFileSync(join(MIGRATIONS_DIR, "meta/_journal.json"), "utf8"),
    ) as { entries: { tag: string }[] };
    const tags = journal.entries.map((entry) => entry.tag);
    const sqlite = new Database(":memory:");
    for (const tag of tags.slice(0, tags.indexOf(TAG))) {
      for (const statement of migrationSql(tag)) sqlite.exec(statement);
    }
    sqlite.exec(
      "INSERT INTO chats (platform, key, kind, started_at) VALUES ('webchat', 'concierge', 'dm', 1)",
    );
    sqlite.exec(
      "INSERT INTO chat_messages (id, chat_id, key, sender_account_id, text, parts, said_at) VALUES (1, 1, 'u1', 'guardian', 'Hello', '[]', 100)",
    );
    sqlite.exec(
      "INSERT INTO chat_messages (id, chat_id, key, sender_account_id, sender_agent, text, parts, reply_to_message_id, root_message_id, said_at) VALUES (2, 1, 'a1', 'agent:main', 'main', 'Hi', '[]', 1, 1, 200)",
    );

    for (const statement of migrationSql(TAG)) sqlite.exec(statement);

    expect(
      sqlite
        .prepare(
          "SELECT key, reply_to_message_id AS replyTo, root_message_id AS root FROM chat_messages ORDER BY id",
        )
        .all(),
    ).toEqual([
      { key: "u1", replyTo: null, root: null },
      { key: "a1", replyTo: 1, root: null },
    ]);
  });
});
