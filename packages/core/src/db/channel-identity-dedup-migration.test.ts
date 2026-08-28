import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { describe, expect, it } from "@rstest/core";
import { STRANGER_PERSON_ID } from "../constants.js";

const MIGRATIONS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../../drizzle/system");
const IDENTITY_INDEX = "idx_channel_mappings_identity";

/**
 * The migration that introduces the identity index, resolved by searching the
 * journal for it rather than by filename. `drizzle-kit generate` mints a new
 * name each time, so a test pinned to one would keep passing against a file
 * nothing runs.
 */
function identityIndexMigration(): string {
  const journal = JSON.parse(readFileSync(join(MIGRATIONS_DIR, "meta/_journal.json"), "utf8")) as {
    entries: { tag: string }[];
  };
  const matches = journal.entries
    .map((entry) => readFileSync(join(MIGRATIONS_DIR, `${entry.tag}.sql`), "utf8"))
    .filter((sql) => sql.includes(IDENTITY_INDEX));

  expect(matches, `exactly one migration should create ${IDENTITY_INDEX}`).toHaveLength(1);
  return matches[0];
}

function applyMigration(sqlite: Database.Database, sql: string): void {
  for (const statement of sql.split("--> statement-breakpoint")) {
    const trimmed = statement.trim();
    if (trimmed) sqlite.exec(trimmed);
  }
}

/** `channel_mappings` as it stood before the identity index, holding the
 *  duplicates the index cannot coexist with. Rows are inserted in the order
 *  below, so their rowids ascend with it — the tie-break the migration uses. */
function databaseWithDuplicates(): Database.Database {
  const sqlite = new Database(":memory:");
  sqlite.pragma("foreign_keys = ON");
  sqlite.exec(`
    CREATE TABLE persons (id text PRIMARY KEY NOT NULL);
    CREATE TABLE channel_mappings (
      id text PRIMARY KEY NOT NULL,
      person_id text NOT NULL,
      channel text NOT NULL,
      channel_user_id text NOT NULL,
      display_name text,
      FOREIGN KEY (person_id) REFERENCES persons(id)
    );
  `);

  const person = sqlite.prepare("INSERT INTO persons (id) VALUES (?)");
  for (const id of [STRANGER_PERSON_ID, "alice", "bob", "carol"]) person.run(id);

  const mapping = sqlite.prepare(
    "INSERT INTO channel_mappings (id, person_id, channel, channel_user_id) VALUES (?, ?, ?, ?)",
  );
  // A dismissal onto the sentinel, then a real placement of the same sender.
  mapping.run("m1", STRANGER_PERSON_ID, "telegram", "tg-contested");
  mapping.run("m2", "alice", "telegram", "tg-contested");
  // Two real placements racing for one sender.
  mapping.run("m3", "bob", "telegram", "tg-raced");
  mapping.run("m4", "carol", "telegram", "tg-raced");
  // Two dismissals of one sender.
  mapping.run("m5", STRANGER_PERSON_ID, "telegram", "tg-dismissed");
  mapping.run("m6", STRANGER_PERSON_ID, "telegram", "tg-dismissed");
  // The same identifier on another channel is a different account.
  mapping.run("m7", "alice", "email", "tg-contested");
  // An account nobody contests.
  mapping.run("m8", "bob", "telegram", "tg-sole");

  return sqlite;
}

function survivors(sqlite: Database.Database): string[] {
  return sqlite
    .prepare("SELECT id FROM channel_mappings ORDER BY id")
    .all()
    .map((row) => (row as { id: string }).id);
}

describe("channel mapping dedup migration", () => {
  it("keeps one row per account, preferring a placement over a dismissal", () => {
    const sqlite = databaseWithDuplicates();
    try {
      applyMigration(sqlite, identityIndexMigration());

      expect(survivors(sqlite)).toEqual([
        // A real placement outranks the dismissal it raced, whichever landed first.
        "m2",
        // Between two placements, and between two dismissals, the oldest wins.
        "m3",
        "m5",
        // Neither of these was ever a duplicate.
        "m7",
        "m8",
      ]);
    } finally {
      sqlite.close();
    }
  });

  it("leaves the identity index rejecting the next duplicate", () => {
    const sqlite = databaseWithDuplicates();
    try {
      applyMigration(sqlite, identityIndexMigration());

      expect(() =>
        sqlite
          .prepare(
            "INSERT INTO channel_mappings (id, person_id, channel, channel_user_id) VALUES (?, ?, ?, ?)",
          )
          .run("m9", "carol", "telegram", "tg-contested"),
      ).toThrow(/UNIQUE constraint failed/);
    } finally {
      sqlite.close();
    }
  });

  it("dismisses onto the sentinel this codebase writes", () => {
    // The migration hard-codes the sentinel, since a migration cannot import it.
    // Renaming the constant without editing the migration would leave the ranking
    // treating every dismissal as a placement.
    expect(identityIndexMigration()).toContain(`'${STRANGER_PERSON_ID}'`);
  });
});
