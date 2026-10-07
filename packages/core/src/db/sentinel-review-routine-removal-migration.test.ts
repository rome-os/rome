import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { sql } from "drizzle-orm";
import { describe, expect, it } from "@rstest/core";
import { createTestDb } from "../test/helpers.js";
import { events } from "./schema.js";
import { RoutinesRepository } from "./repositories/routines.js";
import { SettingsRepository } from "./repositories/settings.js";
import { migrateEventsToRoutines } from "../routines/migrate-events-to-routines.js";

const MIGRATIONS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../../drizzle/system");

/**
 * The migration that deletes sentinel_review routines, resolved by searching
 * the journal rather than by filename, so the test fails if nothing runs it.
 */
function removalMigration(): string {
  const journal = JSON.parse(readFileSync(join(MIGRATIONS_DIR, "meta/_journal.json"), "utf8")) as {
    entries: { tag: string }[];
  };
  const matches = journal.entries
    .map((entry) => readFileSync(join(MIGRATIONS_DIR, `${entry.tag}.sql`), "utf8"))
    .filter((sql) => /DELETE FROM `routines` WHERE `action_name` IN \('sentinel_review', 'system:sentinel_review'\)/.test(sql));

  expect(matches, "exactly one migration should delete sentinel_review routines").toHaveLength(1);
  return matches[0];
}

function statements(migration: string): string[] {
  return migration
    .split("--> statement-breakpoint")
    .map((statement) => statement.trim())
    .filter(Boolean);
}

function applyMigration(sqlite: Database.Database, migration: string): void {
  for (const statement of statements(migration)) sqlite.exec(statement);
}

function databaseWithRoutines(): Database.Database {
  const sqlite = new Database(":memory:");
  sqlite.pragma("foreign_keys = ON");
  sqlite.exec(`
    CREATE TABLE routines (
      id text PRIMARY KEY NOT NULL,
      action_name text NOT NULL
    );
    CREATE TABLE routine_runs (
      id text PRIMARY KEY NOT NULL,
      routine_id text NOT NULL,
      FOREIGN KEY (routine_id) REFERENCES routines(id)
    );
    CREATE TABLE events (
      id text PRIMARY KEY NOT NULL,
      action_name text NOT NULL
    );
  `);

  const routine = sqlite.prepare("INSERT INTO routines (id, action_name) VALUES (?, ?)");
  routine.run("sentinel", "sentinel_review");
  routine.run("sentinel-canonical", "system:sentinel_review");
  routine.run("upgrade", "system_upgrade");

  const run = sqlite.prepare("INSERT INTO routine_runs (id, routine_id) VALUES (?, ?)");
  run.run("sentinel-run-1", "sentinel");
  run.run("sentinel-run-2", "sentinel");
  run.run("sentinel-canonical-run", "sentinel-canonical");
  run.run("upgrade-run", "upgrade");

  const event = sqlite.prepare("INSERT INTO events (id, action_name) VALUES (?, ?)");
  event.run("sentinel-event", "sentinel_review");
  event.run("digest-event", "send_digest");

  return sqlite;
}

function ids(sqlite: Database.Database, table: string): string[] {
  return sqlite
    .prepare(`SELECT id FROM ${table} ORDER BY id`)
    .all()
    .map((row) => (row as { id: string }).id);
}

describe("sentinel_review routine removal migration", () => {
  it("deletes bare and canonical sentinel_review routines and their runs, and keeps every other routine", () => {
    const sqlite = databaseWithRoutines();
    try {
      applyMigration(sqlite, removalMigration());

      expect(ids(sqlite, "routines")).toEqual(["upgrade"]);
      expect(ids(sqlite, "routine_runs")).toEqual(["upgrade-run"]);
      expect(ids(sqlite, "events")).toEqual(["digest-event"]);
    } finally {
      sqlite.close();
    }
  });

  it("leaves no legacy sentinel_review event for the boot-time events conversion to recreate", async () => {
    const testDb = createTestDb();
    try {
      const routinesRepo = new RoutinesRepository(testDb.db);
      const settingsRepo = new SettingsRepository(testDb.db);
      for (const [id, actionName] of [
        ["sentinel-event", "sentinel_review"],
        ["digest-event", "send_digest"],
      ]) {
        await testDb.db.insert(events).values({
          id,
          name: actionName,
          type: "recurring",
          tzid: "UTC",
          localTime: "00:00",
          rrule: "FREQ=HOURLY;INTERVAL=2",
          startTime: new Date("2026-01-01T00:00:00Z"),
          actionName,
          args: [],
          enabled: true,
          createdAt: new Date("2026-01-01T00:00:00Z"),
        });
      }

      // createTestDb already ran every migration against empty tables, so
      // replay the removal over the seeded events, then convert as boot does.
      for (const statement of statements(removalMigration())) {
        testDb.db.run(sql.raw(statement));
      }
      await migrateEventsToRoutines({ db: testDb.db, routinesRepo, settingsRepo });

      const routines = await routinesRepo.findAll();
      expect(routines.map((routine) => routine.actionName)).toEqual(["send_digest"]);
    } finally {
      testDb.close();
    }
  });
});
