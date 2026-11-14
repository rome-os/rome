import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { describe, expect, it } from "@rstest/core";

const MIGRATIONS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../../drizzle/system");
const TAG = "0136_concierge_reaction";

function migrationSql(tag: string): string[] {
  return readFileSync(join(MIGRATIONS_DIR, `${tag}.sql`), "utf8")
    .split("--> statement-breakpoint")
    .map((statement) => statement.trim())
    .filter(Boolean);
}

describe("the concierge reaction migration", () => {
  it("adds the reaction column, drops the status mark's table and column, and keeps the turns", () => {
    const journal = JSON.parse(
      readFileSync(join(MIGRATIONS_DIR, "meta/_journal.json"), "utf8"),
    ) as { entries: { tag: string }[] };
    const tags = journal.entries.map((entry) => entry.tag);
    expect(tags).toContain(TAG);
    const sqlite = new Database(":memory:");
    for (const tag of tags.slice(0, tags.indexOf(TAG))) {
      for (const statement of migrationSql(tag)) sqlite.exec(statement);
    }
    // A database from before: a message, a turn that took it, and a task made for it.
    sqlite.exec(
      "INSERT INTO chats (platform, key, kind, started_at) VALUES ('webchat', 'concierge', 'dm', 1)",
    );
    sqlite
      .prepare(
        "INSERT INTO chat_messages (chat_id, key, text, parts, said_at) VALUES (1, 'm1', 'hi', '[]', 1)",
      )
      .run();
    sqlite
      .prepare(
        "INSERT INTO concierge_message_turns (chat_id, message_key, turn_id, taken_at, answered_at, stopped_untold, turn_failed) VALUES ('concierge', 'm1', 't1', 1, NULL, 1, 1), ('concierge', 'm2', 't2', 2, 3, 0, 0)",
      )
      .run();
    sqlite
      .prepare(
        "INSERT INTO concierge_tasks (id, title, state, created_at, updated_at) VALUES ('task', 'Weather', 'doing', 1, 1)",
      )
      .run();
    sqlite
      .prepare(
        "INSERT INTO concierge_message_tasks (task_id, chat_id, message_key) VALUES ('task', 'concierge', 'm1')",
      )
      .run();

    for (const statement of migrationSql(TAG)) sqlite.exec(statement);

    // The message keeps its text and has no reaction yet.
    expect(sqlite.prepare("SELECT key, text, reaction FROM chat_messages").all()).toEqual([
      { key: "m1", text: "hi", reaction: null },
    ]);
    sqlite.prepare("UPDATE chat_messages SET reaction = '👀' WHERE key = 'm1'").run();
    expect(sqlite.prepare("SELECT reaction FROM chat_messages").get()).toEqual({ reaction: "👀" });
    // The turns stay, whole, for the stopped-request notice.
    expect(
      sqlite
        .prepare(
          "SELECT chat_id, message_key, turn_id, taken_at, answered_at, stopped_untold FROM concierge_message_turns ORDER BY message_key",
        )
        .all(),
    ).toEqual([
      {
        chat_id: "concierge",
        message_key: "m1",
        turn_id: "t1",
        taken_at: 1,
        answered_at: null,
        stopped_untold: 1,
      },
      {
        chat_id: "concierge",
        message_key: "m2",
        turn_id: "t2",
        taken_at: 2,
        answered_at: 3,
        stopped_untold: 0,
      },
    ]);
    const columns = sqlite
      .prepare("SELECT name FROM pragma_table_info('concierge_message_turns')")
      .all()
      .map((row) => (row as { name: string }).name);
    expect(columns).not.toContain("turn_failed");
    expect(
      sqlite.prepare("SELECT name FROM sqlite_master WHERE name = 'concierge_message_tasks'").get(),
    ).toBeUndefined();
    // The task itself is untouched.
    expect(sqlite.prepare("SELECT id FROM concierge_tasks").all()).toEqual([{ id: "task" }]);
    // The turn index survives the dropped column.
    expect(
      sqlite
        .prepare("SELECT name FROM sqlite_master WHERE name = 'idx_concierge_message_turns_turn'")
        .get(),
    ).toEqual({ name: "idx_concierge_message_turns_turn" });
  });
});
