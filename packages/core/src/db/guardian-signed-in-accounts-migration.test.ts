import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { describe, expect, it } from "@rstest/core";

const migrationPath = (name: string) =>
  resolve(dirname(fileURLToPath(import.meta.url)), "../../drizzle/system", name);
const SIGNED_IN = readFileSync(migrationPath("0109_guardian_signed_in_accounts.sql"), "utf8");

function run(sqlite: Database.Database, migration: string): void {
  for (const statement of migration.split("--> statement-breakpoint")) sqlite.exec(statement);
}

function instance(): Database.Database {
  const sqlite = new Database(":memory:");
  sqlite.exec(`
    CREATE TABLE persons (
      id text PRIMARY KEY NOT NULL, display_name text NOT NULL, bond_level text NOT NULL,
      profile_path text, approved integer DEFAULT false, created_at integer NOT NULL
    );
    CREATE TABLE links (
      id text PRIMARY KEY NOT NULL, person_id text NOT NULL, platform text NOT NULL,
      account_id text NOT NULL, delegate integer DEFAULT false NOT NULL
    );
    CREATE UNIQUE INDEX idx_links_account ON links (platform, account_id);
    CREATE TABLE dismissed_accounts (
      platform text NOT NULL, account_id text NOT NULL, PRIMARY KEY (platform, account_id)
    );
    CREATE TABLE channels (
      id text PRIMARY KEY NOT NULL, connection_kind text NOT NULL, platform text NOT NULL,
      connection_id text, platform_account_id text, created_at integer NOT NULL, agent text
    );
  `);
  return sqlite;
}

const linksOf = (sqlite: Database.Database) =>
  sqlite
    .prepare(
      "SELECT person_id, platform, account_id, delegate FROM links ORDER BY platform, account_id",
    )
    .all();

describe("the guardian's signed-in accounts migration", () => {
  it("links each signed-in account to the guardian, and leaves every decided one alone", () => {
    const sqlite = instance();
    sqlite.exec(`
      INSERT INTO persons (id, display_name, bond_level, created_at) VALUES
        ('me', 'Ouou', 'guardian', 1),
        ('alice', 'Alice', 'acquaintance', 1);
      INSERT INTO links (id, person_id, platform, account_id) VALUES
        ('url', 'me', 'linkedin', 'https://www.linkedin.com/in/ouou/'),
        ('taken', 'alice', 'wechat', 'wxid_alice');
      INSERT INTO dismissed_accounts (platform, account_id) VALUES ('telegram', '99');
      INSERT INTO channels (id, connection_kind, platform, connection_id, platform_account_id, created_at) VALUES
        ('telegram_user', 'telegram_user', 'telegram', 'c1', '42', 1),
        ('linkedin', 'linkedin', 'linkedin', 'c2', '123456', 1),
        ('wechat_user', 'wechat_user', 'wechat', 'c3', 'wxid_alice', 1),
        ('dismissed', 'telegram_user', 'telegram', 'c4', '99', 1),
        ('telegram', 'telegram', 'telegram', 'c5', 'bot-1', 1),
        ('gone', 'telegram_user', 'telegram', NULL, '7', 1);
    `);

    run(sqlite, SIGNED_IN);

    expect(linksOf(sqlite)).toEqual([
      { person_id: "me", platform: "linkedin", account_id: "123456", delegate: 0 },
      {
        person_id: "me",
        platform: "linkedin",
        account_id: "https://www.linkedin.com/in/ouou/",
        delegate: 0,
      },
      { person_id: "me", platform: "telegram", account_id: "42", delegate: 0 },
      { person_id: "alice", platform: "wechat", account_id: "wxid_alice", delegate: 0 },
    ]);
  });

  it("links nothing on an instance with no guardian", () => {
    const sqlite = instance();
    sqlite.exec(`
      INSERT INTO channels (id, connection_kind, platform, connection_id, platform_account_id, created_at)
      VALUES ('telegram_user', 'telegram_user', 'telegram', 'c1', '42', 1);
    `);

    run(sqlite, SIGNED_IN);

    expect(linksOf(sqlite)).toEqual([]);
  });
});
