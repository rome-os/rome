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

  it("leaves every message of a Concierge chat its own chat thread, and keeps the roots of every other chat", () => {
    const journal = JSON.parse(
      readFileSync(join(MIGRATIONS_DIR, "meta/_journal.json"), "utf8"),
    ) as { entries: { tag: string }[] };
    const tags = journal.entries.map((entry) => entry.tag);
    const sqlite = new Database(":memory:");
    for (const tag of tags.slice(0, tags.indexOf(TAG))) {
      for (const statement of migrationSql(tag)) sqlite.exec(statement);
    }
    // 1: the main chat. 2: a topic chat. 3: a Telegram chat that Concierge-named
    // session stands in. 4: a task chat. 5: an ordinary dashboard chat.
    sqlite.exec(`INSERT INTO chats (platform, key, kind, started_at) VALUES
      ('webchat', 'concierge', 'dm', 1), ('webchat', 'topic', 'dm', 1), ('telegram', 'tg', 'dm', 1),
      ('webchat', 'task', 'dm', 1), ('webchat', 'plain', 'dm', 1)`);
    const session = sqlite.prepare(
      "INSERT INTO rome_sessions (id, name, type, agent_name, trigger_kind, created_at, activity_at, chat_id) VALUES (?, ?, 'webchat', ?, ?, 1, 1, ?)",
    );
    session.run("concierge", "Concierge", null, null, 1);
    session.run("topic-session", "Topic", "core:concierge", null, 2);
    session.run("tg-session", "Telegram", "concierge", null, 3);
    session.run("task-session", "Task", "main", "concierge-task", 4);
    session.run("plain-session", "Plain", "main", null, 5);
    // Each chat holds a root (id n) and a reply to it (id n + 5) with its root set.
    const insert = sqlite.prepare(
      "INSERT INTO chat_messages (id, chat_id, key, text, parts, reply_to_message_id, root_message_id, said_at) VALUES (?, ?, ?, 'x', '[]', ?, ?, 100)",
    );
    for (let chat = 1; chat <= 5; chat++) {
      insert.run(chat, chat, `root${chat}`, null, null);
      insert.run(chat + 5, chat, `reply${chat}`, chat, chat);
    }

    for (const statement of migrationSql(TAG)) sqlite.exec(statement);

    const rootOf = (id: number) =>
      (
        sqlite
          .prepare("SELECT root_message_id AS root FROM chat_messages WHERE id = ?")
          .get(id) as {
          root: number | null;
        }
      ).root;
    // The main chat and the topic chat start over, and keep what they reply to.
    expect([rootOf(6), rootOf(7)]).toEqual([null, null]);
    expect(
      sqlite.prepare("SELECT reply_to_message_id AS r FROM chat_messages WHERE id = 6").get(),
    ).toEqual({ r: 1 });
    // A Telegram chat, a task chat and an ordinary dashboard chat keep their reply chains.
    expect([rootOf(8), rootOf(9), rootOf(10)]).toEqual([3, 4, 5]);
  });
});
