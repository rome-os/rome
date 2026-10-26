import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { describe, expect, it } from "@rstest/core";

const migrationPath = (name: string) =>
  resolve(dirname(fileURLToPath(import.meta.url)), "../../drizzle/system", name);
const ONE_GRANT = readFileSync(migrationPath("0093_connection_holds_one_grant.sql"), "utf8");

function run(sqlite: Database.Database, migration: string): void {
  for (const statement of migration.split("--> statement-breakpoint")) sqlite.exec(statement);
}

describe("a connection holds one grant migration", () => {
  it("keeps one grant per connection, the one in use", () => {
    const sqlite = new Database(":memory:");
    sqlite.exec(`
      CREATE TABLE connection_grants (
        custody text NOT NULL, name text NOT NULL, state text NOT NULL, credential text,
        profile text, conferred_at integer, last_renewed_at integer, degraded_at integer,
        degraded_reason text, platform text, account_id text,
        PRIMARY KEY (custody, name)
      );
      INSERT INTO connection_grants (custody, name, state, conferred_at, platform, account_id) VALUES
        ('c-one', 'bot', 'authorized', 10, 'telegram', '1'),
        ('c-stale', 'user', 'unauthorized', 30, NULL, NULL),
        ('c-stale', 'bot', 'degraded', 20, 'discord', '2'),
        ('c-twice', 'old', 'authorized', 10, NULL, NULL),
        ('c-twice', 'bot', 'authorized', 40, NULL, NULL),
        ('c-empty', 'bot', 'unauthorized', NULL, NULL, NULL);
    `);

    run(sqlite, ONE_GRANT);

    const rows = sqlite
      .prepare("SELECT custody, state, conferred_at FROM connection_grants ORDER BY custody")
      .all();
    expect(rows).toEqual([
      { custody: "c-empty", state: "unauthorized", conferred_at: null },
      { custody: "c-one", state: "authorized", conferred_at: 10 },
      { custody: "c-stale", state: "degraded", conferred_at: 20 },
      { custody: "c-twice", state: "authorized", conferred_at: 40 },
    ]);
    expect(() =>
      sqlite.exec(
        "INSERT INTO connection_grants (custody, state) VALUES ('c-one', 'unauthorized')",
      ),
    ).toThrow(/UNIQUE/);
  });
});
