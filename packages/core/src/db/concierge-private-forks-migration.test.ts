import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { describe, expect, it } from "@rstest/core";

const MIGRATIONS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../../drizzle/system");
const TAG = "0120_concierge_private_forks";

function migrationSql(tag: string): string[] {
  return readFileSync(join(MIGRATIONS_DIR, `${tag}.sql`), "utf8")
    .split("--> statement-breakpoint")
    .map((statement) => statement.trim())
    .filter(Boolean);
}

/** A database migrated up to, but not including, the fork stamp migration. */
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
       VALUES (?, ?, 'default', 'webchat', 'webchat', ?, ?, ?, ?, 0, 0)`,
    )
    .run(
      row.id,
      row.id,
      row.agentName ?? null,
      row.ownerKey ?? null,
      row.triggerKind ?? null,
      row.parent ?? null,
    );
}

describe("the private fork stamp migration", () => {
  it("stamps every fork that came from a Concierge or task chat with that chat's owner, and no other", () => {
    const sqlite = databaseBeforeMigration();
    insertChat(sqlite, { id: "task", triggerKind: "concierge", ownerKey: "visitor:a" });
    insertChat(sqlite, { id: "branch", triggerKind: "fork", ownerKey: "guardian", parent: "task" });
    insertChat(sqlite, { id: "branch-of-branch", triggerKind: "fork", parent: "branch" });
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
    expect(row("branch-of-branch")).toEqual({ kind: "concierge_fork", owner: "visitor:a" });
    expect(row("topic-fork")).toEqual({ kind: "concierge_fork", owner: "visitor:b" });
    // The private chats themselves and every ordinary line are untouched.
    expect(row("task")).toEqual({ kind: "concierge", owner: "visitor:a" });
    expect(row("plain-fork")).toEqual({ kind: "fork", owner: "guardian" });
  });
});
