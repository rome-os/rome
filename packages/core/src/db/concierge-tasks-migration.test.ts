import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { describe, expect, it } from "@rstest/core";

const MIGRATIONS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../../drizzle/system");
const TAG = "0103_concierge_tasks";
const NOW = Math.floor(Date.now() / 1000);
const DAY = 86_400;

function migrationSql(tag: string): string[] {
  return readFileSync(join(MIGRATIONS_DIR, `${tag}.sql`), "utf8")
    .split("--> statement-breakpoint")
    .map((statement) => statement.trim())
    .filter(Boolean);
}

/** A database migrated up to, but not including, the task list migration. */
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
    name?: string;
    triggerKind?: string | null;
    triggerName?: string | null;
    archivedAt?: number | null;
    activityAt: number;
  },
): void {
  sqlite
    .prepare(
      `INSERT INTO rome_sessions
        (id, name, project_name, type, source_channel, trigger_kind, trigger_name, archived_at, created_at, activity_at)
       VALUES (?, ?, 'default', 'channel', 'webchat', ?, ?, ?, ?, ?)`,
    )
    .run(
      row.id,
      row.name ?? row.id,
      row.triggerKind === undefined ? "concierge" : row.triggerKind,
      row.triggerName ?? null,
      row.archivedAt ?? null,
      row.activityAt - 60,
      row.activityAt,
    );
}

const migrate = (sqlite: Database.Database) => {
  for (const statement of migrationSql(TAG)) sqlite.exec(statement);
};

describe("the Concierge task list migration", () => {
  it("backfills one doing row for each recent, unarchived Concierge task chat", () => {
    const sqlite = databaseBeforeMigration();
    insertChat(sqlite, {
      id: "recent",
      name: "Chat name",
      triggerName: "Fix flaky test",
      activityAt: NOW - DAY,
    });
    insertChat(sqlite, { id: "unnamed", name: "Fallback name", activityAt: NOW - 3 * DAY });
    insertChat(sqlite, { id: "old", activityAt: NOW - 8 * DAY });
    insertChat(sqlite, { id: "archived", archivedAt: NOW - DAY, activityAt: NOW - DAY });
    insertChat(sqlite, { id: "ordinary", triggerKind: null, activityAt: NOW - 60 });
    insertChat(sqlite, { id: "routine", triggerKind: "routine", activityAt: NOW - 60 });

    migrate(sqlite);

    const rows = sqlite
      .prepare(
        "SELECT title, state, session_id, summary, completed_at FROM concierge_tasks ORDER BY session_id",
      )
      .all();
    expect(rows).toEqual([
      {
        title: "Fix flaky test",
        state: "doing",
        session_id: "recent",
        summary: null,
        completed_at: null,
      },
      {
        title: "Fallback name",
        state: "doing",
        session_id: "unnamed",
        summary: null,
        completed_at: null,
      },
    ]);
  });

  it("dates a backfilled row just before its chat's last activity, so the startup catch-up delivers it", () => {
    const sqlite = databaseBeforeMigration();
    insertChat(sqlite, { id: "recent", activityAt: NOW - DAY });
    migrate(sqlite);
    const row = sqlite.prepare("SELECT updated_at FROM concierge_tasks").get() as {
      updated_at: number;
    };
    expect(row.updated_at).toBe((NOW - DAY) * 1000 - 1);
    // The row ids are uuids.
    const { id } = sqlite.prepare("SELECT id FROM concierge_tasks").get() as { id: string };
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it("keeps the row, unlinked, when its chat is deleted", () => {
    const sqlite = databaseBeforeMigration();
    insertChat(sqlite, { id: "recent", activityAt: NOW - DAY });
    migrate(sqlite);
    sqlite.prepare("DELETE FROM rome_sessions WHERE id = 'recent'").run();
    expect(sqlite.prepare("SELECT session_id FROM concierge_tasks").all()).toEqual([
      { session_id: null },
    ]);
  });

  it("links a chat to at most one row, and any number of rows to none", () => {
    const sqlite = databaseBeforeMigration();
    insertChat(sqlite, { id: "chat", triggerKind: null, activityAt: NOW });
    migrate(sqlite);
    const insert = sqlite.prepare(
      "INSERT INTO concierge_tasks (id, title, state, session_id, created_at, updated_at) VALUES (?, 't', 'next', ?, 1, 1)",
    );
    insert.run("a", "chat");
    expect(() => insert.run("b", "chat")).toThrow(/UNIQUE/);
    insert.run("c", null);
    insert.run("d", null);
    expect(sqlite.prepare("SELECT count(*) AS n FROM concierge_tasks").get()).toEqual({ n: 3 });
  });
});
