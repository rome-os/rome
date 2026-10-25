import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { describe, expect, it } from "@rstest/core";

const migrationPath = (name: string) =>
  resolve(dirname(fileURLToPath(import.meta.url)), "../../drizzle/system", name);
const REMOVAL = readFileSync(migrationPath("0090_webchat_is_not_a_connection.sql"), "utf8");

function run(sqlite: Database.Database, migration: string): void {
  for (const statement of migration.split("--> statement-breakpoint")) sqlite.exec(statement);
}

describe("webchat is not a connection migration", () => {
  it("removes the webchat connection and its channel record, and nothing else", () => {
    const sqlite = new Database(":memory:");
    sqlite.exec(`
      CREATE TABLE connections (id text PRIMARY KEY, connection_kind text NOT NULL, label text NOT NULL, created_at integer NOT NULL);
      CREATE TABLE connection_grants (custody text NOT NULL, name text NOT NULL, state text NOT NULL, PRIMARY KEY (custody, name));
      CREATE TABLE channels (id text PRIMARY KEY, connection_kind text NOT NULL, platform text NOT NULL, connection_id text, created_at integer NOT NULL, agent text);
      INSERT INTO connections VALUES ('c-webchat', 'webchat', 'webchat', 0), ('c-telegram', 'telegram', 'telegram', 0);
      INSERT INTO connection_grants VALUES ('c-telegram', 'bot', 'authorized');
      INSERT INTO channels VALUES
        ('webchat', 'webchat', 'webchat', 'c-webchat', 0, NULL),
        ('telegram', 'telegram', 'telegram', 'c-telegram', 0, NULL),
        ('gone', 'telegram', 'telegram', NULL, 0, NULL);
    `);

    run(sqlite, REMOVAL);

    const ids = (table: string) =>
      (sqlite.prepare(`SELECT * FROM ${table}`).all() as Array<Record<string, string>>).map(
        (row) => row.id ?? row.custody,
      );
    expect(ids("connections")).toEqual(["c-telegram"]);
    expect(ids("connection_grants")).toEqual(["c-telegram"]);
    expect(ids("channels").sort()).toEqual(["gone", "telegram"]);
  });
});
