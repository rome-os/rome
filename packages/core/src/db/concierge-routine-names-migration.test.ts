import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { describe, expect, it } from "@rstest/core";

const MIGRATIONS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../../drizzle/system");
const TAG = "0127_concierge_routine_names";

function migrationSql(tag: string): string[] {
  return readFileSync(join(MIGRATIONS_DIR, `${tag}.sql`), "utf8")
    .split("--> statement-breakpoint")
    .map((statement) => statement.trim())
    .filter(Boolean);
}

/** A database migrated up to, but not including, the routine names migration. */
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

describe("the Concierge routine names migration", () => {
  it("drops the Concierge from its digest and follow routines' names, and nothing else", () => {
    const sqlite = databaseBeforeMigration();
    const names = [
      "Concierge digest at 09:00",
      "Concierge follows acme/widgets (GitHub)",
      // Not in the old form: an owner's own routine, and one in another case.
      "Morning briefing",
      "Concierge follows-up on invoices",
      "concierge digest at 18:00",
      "My Concierge digest at 07:00",
    ];
    const insert = sqlite.prepare(
      `INSERT INTO routines (id, name, trigger, action_name, args, created_at)
       VALUES (?, ?, '{}', 'core:any', '[]', 0)`,
    );
    names.forEach((name, index) => insert.run(`r${index}`, name));

    for (const statement of migrationSql(TAG)) sqlite.exec(statement);

    const after = (
      sqlite.prepare("SELECT name FROM routines ORDER BY id").all() as { name: string }[]
    ).map((row) => row.name);
    expect(after).toEqual([
      "Digest at 09:00",
      "Follow acme/widgets (GitHub)",
      "Morning briefing",
      "Concierge follows-up on invoices",
      "concierge digest at 18:00",
      "My Concierge digest at 07:00",
    ]);
    sqlite.close();
  });
});
