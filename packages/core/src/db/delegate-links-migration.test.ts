import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { describe, expect, it } from "@rstest/core";

const migrationPath = (name: string) =>
  resolve(dirname(fileURLToPath(import.meta.url)), "../../drizzle/system", name);
const DELEGATE_LINKS = readFileSync(migrationPath("0099_delegate_links.sql"), "utf8");

function run(sqlite: Database.Database, migration: string): void {
  for (const statement of migration.split("--> statement-breakpoint")) sqlite.exec(statement);
}

describe("the delegate links migration", () => {
  it("marks the guardian's links the Rome Cloud admission made, and nothing else", () => {
    const sqlite = new Database(":memory:");
    sqlite.exec(`
      CREATE TABLE persons (
        id text PRIMARY KEY NOT NULL, display_name text NOT NULL, bond_level text NOT NULL,
        profile_path text, approved integer DEFAULT false, created_at integer NOT NULL
      );
      CREATE TABLE channel_mappings (
        id text PRIMARY KEY NOT NULL, person_id text NOT NULL REFERENCES persons(id),
        channel text NOT NULL, channel_user_id text NOT NULL, display_name text
      );
      CREATE TABLE settings (key text PRIMARY KEY NOT NULL, value text NOT NULL, updated_at integer NOT NULL);
      INSERT INTO persons (id, display_name, bond_level, created_at) VALUES
        ('me', 'Ouou', 'guardian', 1),
        ('alice', 'Alice', 'inner-circle', 1);
      INSERT INTO settings (key, value, updated_at) VALUES
        ('agentsGuardianLinkedAgentIds', '["agt_mine","agt_moved"]', 1);
      INSERT INTO channel_mappings (id, person_id, channel, channel_user_id) VALUES
        ('admitted', 'me', 'agents', 'agt_mine'),
        ('moved', 'alice', 'agents', 'agt_moved'),
        ('by-hand', 'alice', 'agents', 'agt_alices'),
        ('telegram', 'me', 'telegram', 'agt_mine');
    `);

    run(sqlite, DELEGATE_LINKS);

    expect(sqlite.prepare("SELECT id, delegate FROM channel_mappings ORDER BY id").all()).toEqual([
      { id: "admitted", delegate: 1 },
      { id: "by-hand", delegate: 0 },
      { id: "moved", delegate: 0 },
      { id: "telegram", delegate: 0 },
    ]);
  });

  it("marks nothing on an instance where the admission never ran", () => {
    const sqlite = new Database(":memory:");
    sqlite.exec(`
      CREATE TABLE persons (id text PRIMARY KEY, display_name text, bond_level text, created_at integer);
      CREATE TABLE channel_mappings (
        id text PRIMARY KEY, person_id text, channel text, channel_user_id text, display_name text
      );
      CREATE TABLE settings (key text PRIMARY KEY, value text, updated_at integer);
      INSERT INTO persons VALUES ('me', 'Ouou', 'guardian', 1);
      INSERT INTO channel_mappings VALUES ('m', 'me', 'agents', 'agt_x', NULL);
    `);

    run(sqlite, DELEGATE_LINKS);

    expect(sqlite.prepare("SELECT delegate FROM channel_mappings").all()).toEqual([
      { delegate: 0 },
    ]);
  });
});
