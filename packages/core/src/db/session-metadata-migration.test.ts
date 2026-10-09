import { describe, expect, it } from "@rstest/core";
import Database from "better-sqlite3";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { fileURLToPath } from "node:url";

describe("isolated sessions migration", () => {
  it("upgrades existing sessions and actions without changing their behavior", () => {
    const db = new Database(":memory:");
    try {
      const migrations = readMigrationFiles({
        migrationsFolder: fileURLToPath(new URL("../../drizzle/system", import.meta.url)),
      });
      for (const migration of migrations.slice(0, -1)) {
        for (const statement of migration.sql) db.exec(statement);
      }
      db.exec(`INSERT INTO rome_sessions (id, name, created_at, activity_at) VALUES ('old', 'Old chat', 1, 1);
        INSERT INTO action_executions (id, root_execution_id, action_name, status, started_at, created_at)
        VALUES ('old-action', 'old-action', 'notes:read', 'success', 1, 1);`);
      for (const statement of migrations.at(-1)!.sql) db.exec(statement);
      expect(
        db.prepare("SELECT name, metadata_json FROM rome_sessions WHERE id = 'old'").get(),
      ).toEqual({ name: "Old chat", metadata_json: "{}" });
      expect(
        db
          .prepare("SELECT session_id, status FROM action_executions WHERE id = 'old-action'")
          .get(),
      ).toEqual({ session_id: null, status: "success" });
      expect(
        db
          .prepare(
            "SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_action_executions_session_id'",
          )
          .get(),
      ).toEqual({ name: "idx_action_executions_session_id" });
    } finally {
      db.close();
    }
  });
});
