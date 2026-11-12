import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { describe, expect, it } from "@rstest/core";

const MIGRATIONS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../../drizzle/system");
const TAG = "0132_concierge_task_checks";

function migrationSql(tag: string): string[] {
  return readFileSync(join(MIGRATIONS_DIR, `${tag}.sql`), "utf8")
    .split("--> statement-breakpoint")
    .map((statement) => statement.trim())
    .filter(Boolean);
}

/** A database migrated up to, but not including, the task checks migration. */
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

describe("the Concierge task checks migration", () => {
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
});
