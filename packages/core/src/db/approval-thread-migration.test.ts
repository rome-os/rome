import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { describe, expect, it } from "@rstest/core";

const MIGRATIONS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../../drizzle/system");
const TAG = "0133_approval_thread_id";

function migrationSql(tag: string): string[] {
  return readFileSync(join(MIGRATIONS_DIR, `${tag}.sql`), "utf8")
    .split("--> statement-breakpoint")
    .map((statement) => statement.trim())
    .filter(Boolean);
}

describe("the approval thread migration", () => {
  it("keeps the chat each approval was asked in, and none for one asked in no chat", () => {
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
      "INSERT INTO approvals (id, type, status, requested_by, description, payload, created_at) VALUES (?, 'action_execution', 'pending', 'main', 'x', ?, 1)",
    );
    insert.run("in-chat", JSON.stringify({ channelContext: { threadId: "chat-1" } }));
    insert.run("no-chat", JSON.stringify({ sessionId: "s1" }));
    insert.run("no-payload", null);
    insert.run("odd", JSON.stringify({ channelContext: { threadId: 7 } }));

    for (const statement of migrationSql(TAG)) sqlite.exec(statement);

    expect(sqlite.prepare("SELECT id, thread_id FROM approvals ORDER BY id").all()).toEqual([
      { id: "in-chat", thread_id: "chat-1" },
      { id: "no-chat", thread_id: null },
      { id: "no-payload", thread_id: null },
      { id: "odd", thread_id: null },
    ]);
    expect(
      sqlite.prepare("SELECT name FROM sqlite_master WHERE name = 'idx_approvals_thread'").get(),
    ).toEqual({ name: "idx_approvals_thread" });
  });
});
