import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { describe, expect, it } from "@rstest/core";

const MIGRATIONS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../../drizzle/system");
const TAG = "0130_concierge_task_status";

function migrationSql(tag: string): string[] {
  return readFileSync(join(MIGRATIONS_DIR, `${tag}.sql`), "utf8")
    .split("--> statement-breakpoint")
    .map((statement) => statement.trim())
    .filter(Boolean);
}

/** A database migrated up to, but not including, the task status migration. */
function databaseBeforeMigration(): Database.Database {
  const journal = JSON.parse(readFileSync(join(MIGRATIONS_DIR, "meta/_journal.json"), "utf8")) as {
    entries: { tag: string }[];
  };
  const tags = journal.entries.map((entry) => entry.tag);
  expect(tags).toContain(TAG);
  const sqlite = new Database(":memory:");
  for (const tag of tags.slice(0, tags.indexOf(TAG))) {
    for (const statement of migrationSql(tag)) sqlite.exec(statement);
  }
  return sqlite;
}

describe("the Concierge task status migration", () => {
  it("marks every row that links a task chat as linked, so it never links another", () => {
    const sqlite = databaseBeforeMigration();
    // The rows name chats this test makes no session for.
    sqlite.pragma("foreign_keys = OFF");
    const insert = sqlite.prepare(
      "INSERT INTO concierge_tasks (id, title, state, session_id, created_at, updated_at) VALUES (?, ?, 'doing', ?, ?, ?)",
    );
    insert.run("linked", "Linked", "chat-1", 1_000, 2_000);
    insert.run("planned", "Planned", null, 3_000, 3_000);

    for (const statement of migrationSql(TAG)) sqlite.exec(statement);

    expect(
      sqlite
        .prepare(
          "SELECT id, linked_at, archived_with_chat, stopped_at, stop_reason, last_outcome FROM concierge_tasks ORDER BY id",
        )
        .all(),
    ).toEqual([
      {
        id: "linked",
        linked_at: 1_000,
        archived_with_chat: 0,
        stopped_at: null,
        stop_reason: null,
        last_outcome: null,
      },
      {
        id: "planned",
        linked_at: null,
        archived_with_chat: 0,
        stopped_at: null,
        stop_reason: null,
        last_outcome: null,
      },
    ]);
    sqlite.close();
  });

  it("turns each state the Concierge wrote into the facts it stood for", () => {
    const sqlite = databaseBeforeMigration();
    const insert = sqlite.prepare(
      "INSERT INTO concierge_tasks (id, title, state, due_at, completed_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 1, 2)",
    );
    insert.run("done", "Done", "done", null, 50);
    insert.run("dropped", "Dropped", "dropped", null, 60);
    insert.run("next-timed", "Planned", "next", 9_000, null);
    insert.run("next-bare", "Someday", "next", null, null);
    insert.run("watching-bare", "Watched", "watching", null, null);
    insert.run("doing", "Doing", "doing", null, null);
    insert.run("asks", "Asks", "needs_user", null, null);

    for (const statement of migrationSql(TAG)) sqlite.exec(statement);

    expect(
      sqlite
        .prepare(
          "SELECT id, last_outcome, stopped_at, stop_reason, note FROM concierge_tasks ORDER BY id",
        )
        .all(),
    ).toEqual([
      { id: "asks", last_outcome: null, stopped_at: null, stop_reason: null, note: null },
      { id: "doing", last_outcome: null, stopped_at: null, stop_reason: null, note: null },
      { id: "done", last_outcome: "succeeded", stopped_at: null, stop_reason: null, note: null },
      { id: "dropped", last_outcome: null, stopped_at: 60, stop_reason: "concierge", note: null },
      // A planned row with no time and no task chat stays later until the
      // Concierge starts or stops it.
      { id: "next-bare", last_outcome: null, stopped_at: null, stop_reason: null, note: null },
      { id: "next-timed", last_outcome: null, stopped_at: null, stop_reason: null, note: null },
      {
        id: "watching-bare",
        last_outcome: "succeeded",
        stopped_at: null,
        stop_reason: null,
        note: null,
      },
    ]);
    sqlite.close();
  });

  it("names the task of each pending Concierge check named after it, and no other", () => {
    const sqlite = databaseBeforeMigration();
    const task = "0b8f2a4e-3c1d-4e5f-8a9b-0c1d2e3f4a5b";
    sqlite
      .prepare(
        "INSERT INTO concierge_tasks (id, title, state, created_at, updated_at) VALUES (?, 'CI', 'watching', 1, 1)",
      )
      .run(task);
    const routine = sqlite.prepare(
      "INSERT INTO routines (id, name, enabled, trigger, action_name, args, created_at) VALUES (?, ?, ?, '{}', 'resume_session', ?, 1)",
    );
    const concierge = JSON.stringify({ agentName: "core:concierge", threadId: "concierge" });
    routine.run("named", `watch CI task:${task}`, 1, concierge);
    routine.run("fired", `watch CI task:${task}`, 0, concierge);
    routine.run("unknown", "watch task:ffffffff-ffff-4fff-8fff-ffffffffffff", 1, concierge);
    routine.run("other-agent", `watch task:${task}`, 1, JSON.stringify({ agentName: "main" }));

    for (const statement of migrationSql(TAG)) sqlite.exec(statement);

    const taskOf = (id: string) =>
      (
        sqlite
          .prepare("SELECT json_extract(args, '$.taskId') AS taskId FROM routines WHERE id = ?")
          .get(id) as {
          taskId: string | null;
        }
      ).taskId;
    expect(taskOf("named")).toBe(task);
    expect(taskOf("fired")).toBeNull();
    expect(taskOf("unknown")).toBeNull();
    expect(taskOf("other-agent")).toBeNull();
    sqlite.close();
  });

  it("keeps only facts of the reaction ledgers, then drops them", () => {
    const sqlite = databaseBeforeMigration();
    const task = sqlite.prepare(
      "INSERT INTO concierge_tasks (id, title, state, created_at, updated_at) VALUES (?, ?, 'doing', 1, 1)",
    );
    task.run("held", "Held");
    task.run("plain", "Plain");
    task.run("broke", "Broke");
    const turn = sqlite.prepare(
      "INSERT INTO concierge_turn_reactions (turn_id, chat_id, message_key, state, updated_at) VALUES (?, 'c', ?, ?, ?)",
    );
    turn.run("t1", "open", "working", 10);
    turn.run("t1", "done", "failed", 20);
    // Two turns took one message: the newest one is kept.
    turn.run("t1", "moved", "failed", 30);
    turn.run("t2", "moved", "working", 40);
    const taskMark = sqlite.prepare(
      "INSERT INTO concierge_task_reactions (task_id, chat_id, message_key, state, updated_at) VALUES (?, 'c', ?, ?, 1)",
    );
    taskMark.run("held", "open", "done_unsaid");
    taskMark.run("plain", "done", "stopped");
    taskMark.run("broke", "done", "failed");

    for (const statement of migrationSql(TAG)) sqlite.exec(statement);

    expect(
      sqlite
        .prepare(
          "SELECT message_key, turn_id, answered_at FROM concierge_message_turns ORDER BY message_key",
        )
        .all(),
    ).toEqual([
      { message_key: "done", turn_id: "t1", answered_at: 20 },
      { message_key: "moved", turn_id: "t2", answered_at: null },
      { message_key: "open", turn_id: "t1", answered_at: null },
    ]);
    expect(
      sqlite
        .prepare("SELECT task_id, message_key FROM concierge_message_tasks ORDER BY task_id")
        .all(),
    ).toEqual([
      { task_id: "broke", message_key: "done" },
      { task_id: "held", message_key: "open" },
      { task_id: "plain", message_key: "done" },
    ]);
    // A failed turn and a failed task keep their ⚠️.
    expect(
      sqlite
        .prepare(
          "SELECT message_key, turn_failed FROM concierge_message_turns ORDER BY message_key",
        )
        .all(),
    ).toEqual([
      { message_key: "done", turn_failed: 1 },
      { message_key: "moved", turn_failed: 0 },
      { message_key: "open", turn_failed: 0 },
    ]);
    expect(
      sqlite.prepare("SELECT last_outcome FROM concierge_tasks WHERE id = 'broke'").get(),
    ).toEqual({ last_outcome: "failed" });
    expect(
      sqlite.prepare("SELECT id, outcome_unsaid FROM concierge_tasks ORDER BY id").all(),
    ).toEqual([
      { id: "broke", outcome_unsaid: 0 },
      { id: "held", outcome_unsaid: 1 },
      { id: "plain", outcome_unsaid: 0 },
    ]);
    const tables = (
      sqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as {
        name: string;
      }[]
    ).map((row) => row.name);
    expect(tables).not.toContain("concierge_turn_reactions");
    expect(tables).not.toContain("concierge_task_reactions");
    sqlite.close();
  });
});
