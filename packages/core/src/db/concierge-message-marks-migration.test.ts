import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { describe, expect, it } from "@rstest/core";

const MIGRATIONS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../../drizzle/system");
const TAGS = [
  "0133_concierge_message_marks",
  "0134_concierge_drop_reaction_ledgers",
  "0135_concierge_stopped_requests",
  "0136_concierge_wait_expiry",
  "0137_concierge_failed_marks",
];

function migrationSql(tag: string): string[] {
  return readFileSync(join(MIGRATIONS_DIR, `${tag}.sql`), "utf8")
    .split("--> statement-breakpoint")
    .map((statement) => statement.trim())
    .filter(Boolean);
}

/** A database migrated up to, but not including, the message marks migrations. */
function databaseBeforeMigration(): Database.Database {
  const journal = JSON.parse(readFileSync(join(MIGRATIONS_DIR, "meta/_journal.json"), "utf8")) as {
    entries: { tag: string }[];
  };
  const tags = journal.entries.map((entry) => entry.tag);
  for (const tag of TAGS) expect(tags).toContain(tag);
  const sqlite = new Database(":memory:");
  for (const tag of tags.slice(0, tags.indexOf(TAGS[0]!))) {
    for (const statement of migrationSql(tag)) sqlite.exec(statement);
  }
  return sqlite;
}

describe("the Concierge message marks migration", () => {
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

    for (const tag of TAGS) for (const statement of migrationSql(tag)) sqlite.exec(statement);

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
