import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { describe, expect, it } from "@rstest/core";

const MIGRATIONS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../../drizzle/system");
const TAG = "0142_root_message_id";

function migrationSql(tag: string): string[] {
  return readFileSync(join(MIGRATIONS_DIR, `${tag}.sql`), "utf8")
    .split("--> statement-breakpoint")
    .map((statement) => statement.trim())
    .filter(Boolean);
}

describe("the root message id migration", () => {
  it("adds the root column with every existing message its own root, and drops the old columns", () => {
    const journal = JSON.parse(
      readFileSync(join(MIGRATIONS_DIR, "meta/_journal.json"), "utf8"),
    ) as { entries: { tag: string }[] };
    const tags = journal.entries.map((entry) => entry.tag);
    expect(tags).toContain(TAG);
    const sqlite = new Database(":memory:");
    for (const tag of tags.slice(0, tags.indexOf(TAG))) {
      for (const statement of migrationSql(tag)) sqlite.exec(statement);
    }
    // A database from before: a task thread, a message that quotes one
    // outside any thread, and a thread whose root is gone.
    sqlite.exec(
      "INSERT INTO chats (platform, key, kind, started_at) VALUES ('webchat', 'concierge', 'dm', 1), ('webchat', 'topic', 'dm', 1)",
    );
    const insert = sqlite.prepare(
      "INSERT INTO chat_messages (chat_id, key, text, parts, said_at, reply_to_message_id, chat_thread_id, chat_thread_settled) VALUES (?, ?, ?, '[]', ?, ?, ?, ?)",
    );
    // The task thread keyed t1, in two chats.
    insert.run(1, "t1", "Weather?", 1, null, "t1", 1);
    insert.run(1, "a1", "Sunny", 2, null, "t1", 1);
    insert.run(1, "u2", "And Friday?", 3, 2, "t1", 1);
    insert.run(2, "t1", "Other chat", 4, null, null, 0);
    insert.run(2, "b1", "Other chat's thread", 5, null, "t1", 0);
    // Outside any thread: a plain message, and one that only quotes.
    insert.run(1, "p1", "Hello", 6, null, null, 0);
    insert.run(1, "q1", "Quoting", 7, 6, null, 0);
    // A thread whose root message is gone stays its own root.
    insert.run(1, "orphan", "Orphan", 8, null, "deleted", 1);
    sqlite
      .prepare(
        "INSERT INTO concierge_tasks (id, title, state, thread_root, created_at, updated_at) VALUES ('task', 'Weather', 'doing', 't1', 1, 1)",
      )
      .run();

    for (const statement of migrationSql(TAG)) sqlite.exec(statement);

    const rows = sqlite
      .prepare(
        "SELECT m.chat_id AS chat, m.key, m.reply_to_message_id AS replyTo, r.key AS root FROM chat_messages m LEFT JOIN chat_messages r ON r.id = m.root_message_id ORDER BY m.id",
      )
      .all();
    expect(rows).toEqual([
      // Task threads from before are not kept: every message is its own root,
      // and its reply stays as it was.
      { chat: 1, key: "t1", replyTo: null, root: null },
      { chat: 1, key: "a1", replyTo: null, root: null },
      { chat: 1, key: "u2", replyTo: 2, root: null },
      { chat: 2, key: "t1", replyTo: null, root: null },
      { chat: 2, key: "b1", replyTo: null, root: null },
      { chat: 1, key: "p1", replyTo: null, root: null },
      { chat: 1, key: "q1", replyTo: 6, root: null },
      { chat: 1, key: "orphan", replyTo: null, root: null },
    ]);
    const columns = (table: string) =>
      sqlite
        .prepare(`SELECT name FROM pragma_table_info('${table}')`)
        .all()
        .map((row) => (row as { name: string }).name);
    expect(columns("chat_messages")).toContain("root_message_id");
    expect(columns("chat_messages")).not.toContain("chat_thread_id");
    expect(columns("chat_messages")).not.toContain("chat_thread_settled");
    expect(columns("concierge_tasks")).not.toContain("thread_root");
    // The task stays, and the index swap leaves the new one and none of the old.
    expect(sqlite.prepare("SELECT id, title FROM concierge_tasks").all()).toEqual([
      { id: "task", title: "Weather" },
    ]);
    const indexes = sqlite
      .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'chat_messages'")
      .all()
      .map((row) => (row as { name: string }).name);
    expect(indexes).toContain("idx_chat_messages_root");
    expect(indexes).not.toContain("idx_chat_messages_chat_thread");
  });
});
