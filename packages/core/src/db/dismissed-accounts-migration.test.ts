import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { describe, expect, it } from "@rstest/core";

const migrationPath = (name: string) =>
  resolve(dirname(fileURLToPath(import.meta.url)), "../../drizzle/system", name);
const DISMISSED_ACCOUNTS = readFileSync(migrationPath("0097_dismissed_accounts.sql"), "utf8");

function run(sqlite: Database.Database, migration: string): void {
  for (const statement of migration.split("--> statement-breakpoint")) sqlite.exec(statement);
}

describe("the dismissed accounts migration", () => {
  it("turns every link onto the stranger sentinel into a dismissal and retires the sentinel", () => {
    const sqlite = new Database(":memory:");
    sqlite.pragma("foreign_keys = ON");
    sqlite.exec(`
      CREATE TABLE persons (
        id text PRIMARY KEY NOT NULL, display_name text NOT NULL, bond_level text NOT NULL,
        profile_path text, approved integer DEFAULT false, created_at integer NOT NULL
      );
      CREATE TABLE channel_mappings (
        id text PRIMARY KEY NOT NULL, person_id text NOT NULL REFERENCES persons(id),
        channel text NOT NULL, channel_user_id text NOT NULL, display_name text
      );
      CREATE UNIQUE INDEX idx_channel_mappings_identity
        ON channel_mappings (channel, channel_user_id);
      INSERT INTO persons (id, display_name, bond_level, created_at) VALUES
        ('__STRANGER__', '__STRANGER__', 'other', 1),
        ('alice', 'Alice', 'inner-circle', 1);
      INSERT INTO channel_mappings (id, person_id, channel, channel_user_id, display_name) VALUES
        ('m1', '__STRANGER__', 'telegram', 'tg-spam', 'Spammer'),
        ('m2', '__STRANGER__', 'whatsapp', 'wa-unknown', NULL),
        ('m3', 'alice', 'telegram', 'tg-alice', 'Alice');
    `);

    run(sqlite, DISMISSED_ACCOUNTS);

    expect(
      sqlite
        .prepare(
          "SELECT channel, channel_user_id, display_name FROM dismissed_accounts ORDER BY channel",
        )
        .all(),
    ).toEqual([
      { channel: "telegram", channel_user_id: "tg-spam", display_name: "Spammer" },
      { channel: "whatsapp", channel_user_id: "wa-unknown", display_name: null },
    ]);
    expect(sqlite.prepare("SELECT id, person_id FROM channel_mappings").all()).toEqual([
      { id: "m3", person_id: "alice" },
    ]);
    expect(sqlite.prepare("SELECT id FROM persons").all()).toEqual([{ id: "alice" }]);
  });
});
