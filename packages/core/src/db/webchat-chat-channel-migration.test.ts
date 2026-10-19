import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { describe, expect, it } from "@rstest/core";

const MIGRATIONS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../../drizzle/system");
const TAG = "0078_webchat_chats_as_channel_rows";

function migrationSql(tag: string): string[] {
  return readFileSync(join(MIGRATIONS_DIR, `${tag}.sql`), "utf8")
    .split("--> statement-breakpoint")
    .map((statement) => statement.trim())
    .filter(Boolean);
}

/** A database migrated up to, but not including, the chat migration. */
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

function insertSession(
  sqlite: Database.Database,
  row: {
    id: string;
    type: string;
    sourceChannel?: string | null;
    sourceThreadId?: string | null;
    parentSessionId?: string | null;
  },
): void {
  sqlite
    .prepare(
      `INSERT INTO rome_sessions
        (id, name, project_name, type, source_channel, source_thread_id, parent_session_id, created_at, activity_at)
       VALUES (?, ?, 'Rome', ?, ?, ?, ?, 1, 1)`,
    )
    .run(
      row.id,
      row.id,
      row.type,
      row.sourceChannel ?? null,
      row.sourceThreadId ?? null,
      row.parentSessionId ?? null,
    );
}

function insertMessage(sqlite: Database.Database, id: string, sessionId: string): void {
  sqlite
    .prepare(
      `INSERT INTO rome_agent_messages (id, session_id, role, content, created_at)
       VALUES (?, ?, 'assistant', '[]', 1)`,
    )
    .run(id, sessionId);
}

describe("webchat chats as channel rows migration", () => {
  it("moves chats to channel rows and removes the stray rows beside them", () => {
    const sqlite = databaseBeforeMigration();
    insertSession(sqlite, {
      id: "chat-1",
      type: "webchat",
      sourceChannel: "webchat",
      sourceThreadId: "chat-1",
    });
    insertMessage(sqlite, "chat-line", "chat-1");
    // A fork promoted to a chat keeps its parent's address.
    insertSession(sqlite, {
      id: "promoted",
      type: "webchat",
      sourceChannel: "webchat",
      sourceThreadId: "chat-1",
    });
    // An earlier app send's copy of a line chat-1 already holds.
    insertSession(sqlite, {
      id: "channel:webchat:chat-1",
      type: "channel",
      sourceChannel: "webchat",
      sourceThreadId: "chat-1",
    });
    insertMessage(sqlite, "stray-copy", "channel:webchat:chat-1");
    insertSession(sqlite, {
      id: "fork-1",
      type: "fork",
      sourceChannel: "webchat",
      sourceThreadId: "chat-1",
      parentSessionId: "chat-1",
    });
    insertSession(sqlite, {
      id: "handoff-1",
      type: "webchat_handoff",
      sourceChannel: "webchat",
      sourceThreadId: "handoff-1",
      parentSessionId: "chat-1",
    });
    // A chat already stored as a channel row at its own address.
    insertSession(sqlite, {
      id: "chat-2",
      type: "channel",
      sourceChannel: "webchat",
      sourceThreadId: "chat-2",
    });
    insertMessage(sqlite, "chat-2-line", "chat-2");
    insertSession(sqlite, {
      id: "channel:telegram:t-1",
      type: "channel",
      sourceChannel: "telegram",
      sourceThreadId: "t-1",
    });

    for (const statement of migrationSql(TAG)) sqlite.exec(statement);

    expect(
      sqlite
        .prepare(
          "SELECT id, type, source_channel AS sourceChannel, source_thread_id AS sourceThreadId FROM rome_sessions ORDER BY id",
        )
        .all(),
    ).toEqual([
      {
        id: "channel:telegram:t-1",
        type: "channel",
        sourceChannel: "telegram",
        sourceThreadId: "t-1",
      },
      { id: "chat-1", type: "channel", sourceChannel: "webchat", sourceThreadId: "chat-1" },
      { id: "chat-2", type: "channel", sourceChannel: "webchat", sourceThreadId: "chat-2" },
      { id: "fork-1", type: "fork", sourceChannel: "webchat", sourceThreadId: "chat-1" },
      {
        id: "handoff-1",
        type: "webchat_handoff",
        sourceChannel: "webchat",
        sourceThreadId: "handoff-1",
      },
      { id: "promoted", type: "channel", sourceChannel: "webchat", sourceThreadId: "promoted" },
    ]);
    expect(sqlite.prepare("SELECT id FROM rome_agent_messages ORDER BY id").all()).toEqual([
      { id: "chat-2-line" },
      { id: "chat-line" },
    ]);
  });
});
