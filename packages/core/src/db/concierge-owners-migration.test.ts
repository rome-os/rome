import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { describe, expect, it } from "@rstest/core";

const MIGRATIONS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../../drizzle/system");
const TAG = "0118_concierge_owners";

function migrationSql(tag: string): string[] {
  return readFileSync(join(MIGRATIONS_DIR, `${tag}.sql`), "utf8")
    .split("--> statement-breakpoint")
    .map((statement) => statement.trim())
    .filter(Boolean);
}

/** A database migrated up to, but not including, the owners migration. */
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

function insertChat(
  sqlite: Database.Database,
  row: {
    id: string;
    agentName?: string | null;
    ownerKey?: string | null;
    triggerKind?: string | null;
    parent?: string | null;
  },
): void {
  sqlite
    .prepare(
      `INSERT INTO rome_sessions
        (id, name, project_name, type, source_channel, agent_name, owner_key, trigger_kind, parent_session_id, created_at, activity_at)
       VALUES (?, ?, 'default', ?, 'webchat', ?, ?, ?, ?, 0, 0)`,
    )
    .run(
      row.id,
      row.id,
      row.parent ? "fork" : "channel",
      row.agentName ?? null,
      row.ownerKey ?? null,
      row.triggerKind ?? null,
      row.parent ?? null,
    );
}

describe("the Concierge owners migration", () => {
  it("gives each task row its chat's owner, and the guardian when it has none", () => {
    const sqlite = databaseBeforeMigration();
    insertChat(sqlite, { id: "ann-topic", agentName: "core:concierge", ownerKey: "visitor:a" });
    insertChat(sqlite, { id: "concierge", agentName: "core:concierge" });
    const insertTask = sqlite.prepare(
      `INSERT INTO concierge_tasks (id, title, state, chat_id, created_at, updated_at)
       VALUES (?, ?, 'next', ?, 0, 0)`,
    );
    insertTask.run("t-ann", "A", "ann-topic");
    insertTask.run("t-main", "B", null);
    insertTask.run("t-guardian-chat", "C", "concierge");

    for (const statement of migrationSql(TAG)) sqlite.exec(statement);

    const owner = (id: string) =>
      (
        sqlite.prepare("SELECT owner_key AS owner FROM concierge_tasks WHERE id = ?").get(id) as {
          owner: string;
        }
      ).owner;
    expect(owner("t-ann")).toBe("visitor:a");
    expect(owner("t-main")).toBe("guardian");
    expect(owner("t-guardian-chat")).toBe("guardian");
  });

  it("marks each fork of a Concierge or task chat private to that chat's owner, and no other", () => {
    const sqlite = databaseBeforeMigration();
    insertChat(sqlite, { id: "task", triggerKind: "concierge", ownerKey: "visitor:a" });
    insertChat(sqlite, { id: "branch", triggerKind: "fork", ownerKey: "guardian", parent: "task" });
    insertChat(sqlite, { id: "topic", agentName: "core:concierge", ownerKey: "visitor:b" });
    insertChat(sqlite, { id: "topic-fork", triggerKind: "fork", parent: "topic" });
    insertChat(sqlite, { id: "plain", ownerKey: "guardian" });
    insertChat(sqlite, {
      id: "plain-fork",
      triggerKind: "fork",
      ownerKey: "guardian",
      parent: "plain",
    });

    for (const statement of migrationSql(TAG)) sqlite.exec(statement);

    const row = (id: string) =>
      sqlite
        .prepare("SELECT trigger_kind AS kind, owner_key AS owner FROM rome_sessions WHERE id = ?")
        .get(id);
    expect(row("branch")).toEqual({ kind: "concierge_fork", owner: "visitor:a" });
    expect(row("topic-fork")).toEqual({ kind: "concierge_fork", owner: "visitor:b" });
    // The private chats themselves and every ordinary line are untouched.
    expect(row("task")).toEqual({ kind: "concierge", owner: "visitor:a" });
    expect(row("plain-fork")).toEqual({ kind: "fork", owner: "guardian" });
  });
});
