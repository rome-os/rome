import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { describe, expect, it } from "@rstest/core";

const MIGRATIONS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../../drizzle/system");
const TAG = "0149_task_is_chat";
const NOW = Math.floor(Date.now() / 1000);

function migrationSql(tag: string): string[] {
  return readFileSync(join(MIGRATIONS_DIR, `${tag}.sql`), "utf8")
    .split("--> statement-breakpoint")
    .map((statement) => statement.trim())
    .filter(Boolean);
}

/** A database migrated up to, but not including, the migration that makes a task its task chat. */
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
    name: string;
    agent?: string | null;
    trigger?: string | null;
    owner?: string | null;
  },
): void {
  sqlite
    .prepare(
      `INSERT INTO rome_sessions
        (id, name, project_name, type, source_channel, agent_name, trigger_kind, owner_key, created_at, activity_at)
       VALUES (?, ?, 'default', 'channel', 'webchat', ?, ?, ?, ?, ?)`,
    )
    .run(
      row.id,
      row.name,
      row.agent ?? null,
      row.trigger ?? null,
      row.owner ?? null,
      NOW - 100,
      NOW - 50,
    );
}

function insertTask(
  sqlite: Database.Database,
  row: { id: string; title: string; sessionId: string | null; chatId?: string | null } & Record<
    string,
    unknown
  >,
): void {
  sqlite
    .prepare(
      `INSERT INTO concierge_tasks
        (id, title, state, session_id, chat_id, summary, note, stopped_at, stop_reason, last_outcome,
         outcome_unsaid, ended_at, archived_at, created_at, updated_at)
       VALUES (?, ?, 'doing', ?, ?, 'a summary', ?, ?, ?, ?, ?, ?, ?, 1000, 2000)`,
    )
    .run(
      row.id,
      row.title,
      row.sessionId,
      row.chatId ?? null,
      row.note ?? null,
      row.stoppedAt ?? null,
      row.stopReason ?? null,
      row.lastOutcome ?? null,
      row.outcomeUnsaid ?? 0,
      row.endedAt ?? null,
      row.archivedAt ?? null,
    );
}

describe("the task-is-chat migration", () => {
  it("moves each row to its task chat's id, keeping the facts Rome reports from", () => {
    const sqlite = databaseBeforeMigration();
    insertChat(sqlite, { id: "topic", name: "Trips", agent: "core:concierge" });
    insertChat(sqlite, { id: "chat-a", name: "Flights", trigger: "concierge" });
    insertChat(sqlite, {
      id: "chat-b",
      name: "Hotels (chat name)",
      trigger: "concierge",
      owner: "visitor:ann",
    });
    insertTask(sqlite, {
      id: "task-a",
      title: "Flights",
      sessionId: "chat-a",
      chatId: "topic",
      note: "fly Friday",
      lastOutcome: "succeeded",
      outcomeUnsaid: 1,
      endedAt: 5_000,
    });
    insertTask(sqlite, {
      id: "task-b",
      title: "Hotels (task title)",
      sessionId: "chat-b",
      stoppedAt: 4_000,
      stopReason: "guardian",
      endedAt: 4_000,
    });

    for (const statement of migrationSql(TAG)) sqlite.exec(statement);

    expect(
      sqlite
        .prepare(
          `SELECT session_id, concierge_chat_id, note, stopped_at, last_outcome, outcome_unsaid, ended_at, updated_at
           FROM task_chats ORDER BY session_id`,
        )
        .all(),
    ).toEqual([
      {
        session_id: "chat-a",
        concierge_chat_id: "topic",
        note: "fly Friday",
        stopped_at: null,
        last_outcome: "succeeded",
        outcome_unsaid: 1,
        ended_at: 5_000,
        updated_at: 2_000,
      },
      {
        session_id: "chat-b",
        concierge_chat_id: null,
        note: null,
        stopped_at: 4_000,
        last_outcome: null,
        outcome_unsaid: 0,
        ended_at: 4_000,
        updated_at: 2_000,
      },
    ]);
    // The old table is gone; a task's name is its chat's.
    expect(
      sqlite.prepare("SELECT name FROM sqlite_master WHERE name = 'concierge_tasks'").all(),
    ).toEqual([]);
    expect(sqlite.prepare("SELECT name FROM rome_sessions WHERE id = 'chat-b'").get()).toEqual({
      name: "Hotels (chat name)",
    });
    sqlite.close();
  });

  it("ends a row with no chat, and archives the chat of a row archived on its own", () => {
    const sqlite = databaseBeforeMigration();
    // The row of a deleted chat names a chat that is not there.
    sqlite.pragma("foreign_keys = OFF");
    insertChat(sqlite, { id: "chat-a", name: "Archived task", trigger: "concierge" });
    insertTask(sqlite, { id: "no-chat", title: "Never started", sessionId: null });
    insertTask(sqlite, { id: "gone", title: "Chat deleted", sessionId: "deleted-chat-id" });
    insertTask(sqlite, { id: "task-a", title: "A", sessionId: "chat-a", archivedAt: 9_000_000 });

    for (const statement of migrationSql(TAG)) sqlite.exec(statement);

    expect(sqlite.prepare("SELECT session_id FROM task_chats").all()).toEqual([
      { session_id: "chat-a" },
    ]);
    // Archiving is the chat's now.
    expect(
      sqlite.prepare("SELECT archived_at FROM rome_sessions WHERE id = 'chat-a'").get(),
    ).toEqual({
      archived_at: 9_000,
    });
    sqlite.close();
  });

  it("gives a task chat from before the todo list a row, ended when its chat last ran", () => {
    const sqlite = databaseBeforeMigration();
    insertChat(sqlite, { id: "old-task", name: "Old", trigger: "concierge" });
    insertChat(sqlite, {
      id: "concierge",
      name: "Main",
      agent: "core:concierge",
      trigger: "concierge",
    });
    insertChat(sqlite, { id: "plain", name: "Plain" });

    for (const statement of migrationSql(TAG)) sqlite.exec(statement);

    expect(
      sqlite.prepare("SELECT session_id, concierge_chat_id, ended_at FROM task_chats").all(),
    ).toEqual([{ session_id: "old-task", concierge_chat_id: null, ended_at: (NOW - 50) * 1000 }]);
    sqlite.close();
  });

  it("points a message's tasks at their chats, and drops the links of a task with no chat", () => {
    const sqlite = databaseBeforeMigration();
    insertChat(sqlite, { id: "chat-a", name: "Flights", trigger: "concierge" });
    insertTask(sqlite, { id: "task-a", title: "Flights", sessionId: "chat-a" });
    insertTask(sqlite, { id: "no-chat", title: "Never started", sessionId: null });
    const link = sqlite.prepare(
      "INSERT INTO concierge_message_tasks (task_id, chat_id, message_key, seq, ended_as) VALUES (?, 'concierge', ?, ?, ?)",
    );
    link.run("task-a", "m1", 3, null);
    link.run("task-a", "m2", 4, "done");
    link.run("no-chat", "m3", 5, null);

    for (const statement of migrationSql(TAG)) sqlite.exec(statement);

    expect(
      sqlite
        .prepare(
          "SELECT task_chat_id, chat_id, message_key, seq, ended_as FROM concierge_message_tasks ORDER BY message_key",
        )
        .all(),
    ).toEqual([
      { task_chat_id: "chat-a", chat_id: "concierge", message_key: "m1", seq: 3, ended_as: null },
      { task_chat_id: "chat-a", chat_id: "concierge", message_key: "m2", seq: 4, ended_as: "done" },
    ]);
    // Deleting the chat takes its message links with it.
    sqlite.pragma("foreign_keys = ON");
    sqlite.prepare("DELETE FROM task_chats WHERE session_id = 'chat-a'").run();
    expect(sqlite.prepare("SELECT * FROM concierge_message_tasks").all()).toEqual([]);
    sqlite.close();
  });

  it("re-keys a task's checks and schedule to its chat's id, and removes those of a task with no chat", () => {
    const sqlite = databaseBeforeMigration();
    insertChat(sqlite, { id: "chat-a", name: "Flights", trigger: "concierge" });
    insertTask(sqlite, { id: "task-a", title: "Flights", sessionId: "chat-a" });
    insertTask(sqlite, { id: "no-chat", title: "Never started", sessionId: null });
    const routine = sqlite.prepare(
      "INSERT INTO routines (id, name, key, enabled, trigger, action_name, args, created_at) VALUES (?, ?, ?, 1, '{}', ?, ?, 1)",
    );
    const wake = (taskId: string) =>
      JSON.stringify({ agentName: "core:concierge", threadId: "concierge", taskId });
    routine.run("check-a", "check", null, "resume_session", wake("task-a"));
    routine.run("check-none", "check", null, "resume_session", wake("no-chat"));
    routine.run(
      "plain-check",
      "plain",
      null,
      "resume_session",
      JSON.stringify({ threadId: "concierge" }),
    );
    const run = (taskId: string) =>
      JSON.stringify({ taskId, report: "every_run", brief: "Summarize", skill: "s" });
    routine.run(
      "sched-a",
      "Daily",
      "concierge-task-schedule:task-a",
      "core:concierge_task_run",
      run("task-a"),
    );
    routine.run(
      "sched-none",
      "Orphan",
      "concierge-task-schedule:no-chat",
      "core:concierge_task_run",
      run("no-chat"),
    );

    for (const statement of migrationSql(TAG)) sqlite.exec(statement);

    const args = (id: string) =>
      JSON.parse(
        (sqlite.prepare("SELECT args FROM routines WHERE id = ?").get(id) as { args: string }).args,
      );
    // A check names the task's chat, whatever its task was called.
    expect(args("check-a")).toEqual({
      agentName: "core:concierge",
      threadId: "concierge",
      chatId: "chat-a",
    });
    // One whose task had no chat is a plain check.
    expect(args("check-none")).toEqual({ agentName: "core:concierge", threadId: "concierge" });
    expect(args("plain-check")).toEqual({ threadId: "concierge" });
    // A schedule is keyed by the chat, and names it.
    expect(sqlite.prepare("SELECT key, args FROM routines WHERE id = 'sched-a'").get()).toEqual({
      key: "concierge-task-schedule:chat-a",
      args: JSON.stringify({
        report: "every_run",
        brief: "Summarize",
        skill: "s",
        chatId: "chat-a",
      }),
    });
    expect(sqlite.prepare("SELECT id FROM routines WHERE id = 'sched-none'").all()).toEqual([]);
    sqlite.close();
  });
});
