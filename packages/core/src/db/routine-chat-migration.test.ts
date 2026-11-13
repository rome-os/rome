import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { describe, expect, it } from "@rstest/core";

const MIGRATIONS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../../drizzle/system");
const TAG = "0134_routine_chat";

function migrationSql(tag: string): string[] {
  return readFileSync(join(MIGRATIONS_DIR, `${tag}.sql`), "utf8")
    .split("--> statement-breakpoint")
    .map((statement) => statement.trim())
    .filter(Boolean);
}

describe("the routine chat migration", () => {
  it("keeps the chat an older routine sends into, and none for a shared one", () => {
    const journal = JSON.parse(
      readFileSync(join(MIGRATIONS_DIR, "meta/_journal.json"), "utf8"),
    ) as { entries: { tag: string }[] };
    const tags = journal.entries.map((entry) => entry.tag);
    expect(tags).toContain(TAG);
    const sqlite = new Database(":memory:");
    for (const tag of tags.slice(0, tags.indexOf(TAG))) {
      for (const statement of migrationSql(tag)) sqlite.exec(statement);
    }
    const insert = sqlite.prepare(
      "INSERT INTO routines (id, name, trigger, action_name, args, created_at) VALUES (?, 'x', '{}', ?, ?, 1)",
    );
    insert.run("summary", "send_user_message", JSON.stringify({ sessionId: "chat-1", text: "hi" }));
    insert.run("prefixed", "system:send_user_message", JSON.stringify({ sessionId: "chat-2" }));
    insert.run("check", "resume_session", JSON.stringify({ threadId: "chat-3", sessionId: "s" }));
    insert.run("send", "send_message", JSON.stringify({ threadId: "chat-4" }));
    insert.run("follow", "core:concierge_follow_event", JSON.stringify({ threadId: "nope" }));
    insert.run("new-chat", "send_user_message", JSON.stringify({ text: "starts a chat" }));
    insert.run("odd", "send_user_message", JSON.stringify({ sessionId: 7 }));

    for (const statement of migrationSql(TAG)) sqlite.exec(statement);

    expect(sqlite.prepare("SELECT id, chat_id FROM routines ORDER BY id").all()).toEqual([
      { id: "check", chat_id: "chat-3" },
      { id: "follow", chat_id: null },
      { id: "new-chat", chat_id: null },
      { id: "odd", chat_id: null },
      { id: "prefixed", chat_id: "chat-2" },
      { id: "send", chat_id: "chat-4" },
      { id: "summary", chat_id: "chat-1" },
    ]);
    expect(
      sqlite.prepare("SELECT name FROM sqlite_master WHERE name = 'idx_routines_chat_id'").get(),
    ).toEqual({ name: "idx_routines_chat_id" });
  });
});
