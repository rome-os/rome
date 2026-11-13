import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { describe, expect, it } from "@rstest/core";

const MIGRATIONS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../../drizzle/system");
const TAG = "0133_approval_thread_index";

function migrationSql(tag: string): string[] {
  return readFileSync(join(MIGRATIONS_DIR, `${tag}.sql`), "utf8")
    .split("--> statement-breakpoint")
    .map((statement) => statement.trim())
    .filter(Boolean);
}

describe("the approval thread index", () => {
  it("finds a chat's approvals by the chat their payload names, through the index", () => {
    const journal = JSON.parse(
      readFileSync(join(MIGRATIONS_DIR, "meta/_journal.json"), "utf8"),
    ) as { entries: { tag: string }[] };
    const tags = journal.entries.map((entry) => entry.tag);
    expect(tags).toContain(TAG);
    const sqlite = new Database(":memory:");
    for (const tag of tags.slice(0, tags.indexOf(TAG) + 1)) {
      for (const statement of migrationSql(tag)) sqlite.exec(statement);
    }
    const insert = sqlite.prepare(
      "INSERT INTO approvals (id, type, status, requested_by, description, payload, created_at) VALUES (?, 'action_execution', 'pending', 'main', 'x', ?, 1)",
    );
    insert.run("in-chat", JSON.stringify({ channelContext: { threadId: "chat-1" } }));
    insert.run("no-chat", JSON.stringify({ sessionId: "s1" }));
    const query =
      "SELECT id FROM approvals WHERE json_extract(payload, '$.channelContext.threadId') = 'chat-1'";
    expect(sqlite.prepare(query).all()).toEqual([{ id: "in-chat" }]);
    const plan = sqlite.prepare(`EXPLAIN QUERY PLAN ${query}`).all() as { detail: string }[];
    expect(plan.map((row) => row.detail).join(" ")).toContain("idx_approvals_thread");
    // The approvals table keeps no copy of the chat.
    const columns = sqlite.prepare("PRAGMA table_info(approvals)").all() as { name: string }[];
    expect(columns.map((column) => column.name)).not.toContain("thread_id");
  });

  it("replaces the index a first version of this migration made on a dev database", () => {
    const sqlite = new Database(":memory:");
    sqlite.exec(
      "CREATE TABLE approvals (id text PRIMARY KEY, payload text, thread_id text); CREATE INDEX idx_approvals_thread ON approvals (thread_id);",
    );
    for (const statement of migrationSql(TAG)) sqlite.exec(statement);
    const plan = sqlite
      .prepare(
        "EXPLAIN QUERY PLAN SELECT id FROM approvals WHERE json_extract(payload, '$.channelContext.threadId') = 'x'",
      )
      .all() as { detail: string }[];
    expect(plan.map((row) => row.detail).join(" ")).toContain("idx_approvals_thread");
  });
});
