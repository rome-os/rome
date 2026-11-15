import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { describe, expect, it } from "@rstest/core";

const MIGRATIONS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../../drizzle/system");
const TAG = "0140_concierge_message_status";

function migrationSql(tag: string): string[] {
  return readFileSync(join(MIGRATIONS_DIR, `${tag}.sql`), "utf8")
    .split("--> statement-breakpoint")
    .map((statement) => statement.trim())
    .filter(Boolean);
}

describe("the concierge message status migration", () => {
  it("adds the message-to-task link and the failed flag, keeps the turns, and drops the 👀 reactions", () => {
    const journal = JSON.parse(
      readFileSync(join(MIGRATIONS_DIR, "meta/_journal.json"), "utf8"),
    ) as { entries: { tag: string }[] };
    const tags = journal.entries.map((entry) => entry.tag);
    expect(tags).toContain(TAG);
    const sqlite = new Database(":memory:");
    for (const tag of tags.slice(0, tags.indexOf(TAG))) {
      for (const statement of migrationSql(tag)) sqlite.exec(statement);
    }
    // A database from before: messages the Concierge reacted to, and a turn that took one.
    sqlite.exec(
      "INSERT INTO chats (platform, key, kind, started_at) VALUES ('webchat', 'concierge', 'dm', 1)",
    );
    sqlite
      .prepare(
        "INSERT INTO chat_messages (chat_id, key, text, parts, said_at, reaction) VALUES (1, 'm1', 'do it', '[]', 1, '👀'), (1, 'm2', 'thanks', '[]', 2, '❤️')",
      )
      .run();
    sqlite
      .prepare(
        "INSERT INTO concierge_message_turns (chat_id, message_key, turn_id, taken_at, answered_at, stopped_untold) VALUES ('concierge', 'm1', 't1', 1, 2, 0)",
      )
      .run();
    sqlite
      .prepare(
        "INSERT INTO concierge_tasks (id, title, state, created_at, updated_at) VALUES ('task', 'Weather', 'doing', 1, 1)",
      )
      .run();

    for (const statement of migrationSql(TAG)) sqlite.exec(statement);

    // 👀 is Rome's status now, so a Concierge's 👀 from before goes; other reactions stay.
    expect(sqlite.prepare("SELECT key, reaction FROM chat_messages ORDER BY key").all()).toEqual([
      { key: "m1", reaction: null },
      { key: "m2", reaction: "❤️" },
    ]);
    // The turn stays, not working and not failed: history gets no status.
    expect(
      sqlite
        .prepare(
          "SELECT message_key, answered_at, working_at, turn_failed, reacted FROM concierge_message_turns",
        )
        .all(),
    ).toEqual([
      { message_key: "m1", answered_at: 2, working_at: null, turn_failed: 0, reacted: 0 },
    ]);
    // A task links to the message it was made for, and goes with its task.
    sqlite.pragma("foreign_keys = ON");
    sqlite
      .prepare(
        "INSERT INTO concierge_message_tasks (task_id, chat_id, message_key) VALUES ('task', 'concierge', 'm1')",
      )
      .run();
    expect(sqlite.prepare("SELECT seq FROM concierge_message_tasks").get()).toEqual({ seq: 0 });
    sqlite.prepare("DELETE FROM concierge_tasks WHERE id = 'task'").run();
    expect(sqlite.prepare("SELECT * FROM concierge_message_tasks").all()).toEqual([]);
  });
});
