import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { describe, expect, it } from "@rstest/core";

const migrationPath = (name: string) =>
  resolve(dirname(fileURLToPath(import.meta.url)), "../../drizzle/system", name);
const LINKS_BY_PLATFORM = readFileSync(migrationPath("0100_links_by_platform.sql"), "utf8");

const LARK_CHANNEL = "6f1c2a9e-0000-4000-8000-000000000001";

function run(sqlite: Database.Database, migration: string): void {
  for (const statement of migration.split("--> statement-breakpoint")) sqlite.exec(statement);
}

/** The tables the migration reads, as they stand before it, with the channel
 *  records `channels` names. */
function before(channels: string): Database.Database {
  const sqlite = new Database(":memory:");
  sqlite.pragma("foreign_keys = ON");
  sqlite.exec(`
    CREATE TABLE persons (
      id text PRIMARY KEY NOT NULL, display_name text NOT NULL, bond_level text NOT NULL,
      profile_path text, approved integer DEFAULT false, created_at integer NOT NULL
    );
    CREATE TABLE channel_mappings (
      id text PRIMARY KEY NOT NULL, person_id text NOT NULL REFERENCES persons(id),
      channel text NOT NULL, channel_user_id text NOT NULL, display_name text,
      delegate integer DEFAULT false NOT NULL
    );
    CREATE UNIQUE INDEX idx_channel_mappings_identity
      ON channel_mappings (channel, channel_user_id);
    CREATE TABLE dismissed_accounts (
      channel text NOT NULL, channel_user_id text NOT NULL, display_name text,
      PRIMARY KEY(channel, channel_user_id)
    );
    CREATE TABLE channels (
      id text PRIMARY KEY NOT NULL, connection_kind text NOT NULL, platform text NOT NULL,
      connection_id text, platform_account_id text, created_at integer NOT NULL, agent text
    );
    CREATE TABLE sentinel_log (
      id text PRIMARY KEY NOT NULL, message_id text NOT NULL, channel text NOT NULL,
      channel_user_id text NOT NULL, display_name text, thread_id text, text text,
      action text NOT NULL, response text, reviewed integer DEFAULT false,
      created_at integer NOT NULL
    );
    CREATE TABLE account_profiles (
      platform text NOT NULL, account_id text NOT NULL, display_name text, handle text,
      avatar_url text, source text NOT NULL, updated_at integer NOT NULL,
      PRIMARY KEY(platform, account_id)
    );
    INSERT INTO persons (id, display_name, bond_level, created_at) VALUES
      ('ouou', 'Ouou', 'guardian', 1),
      ('alice', 'Alice', 'inner-circle', 1),
      ('bob', 'Bob', 'acquaintance', 1);
    ${channels}
  `);
  return sqlite;
}

const links = (sqlite: Database.Database) =>
  sqlite
    .prepare(
      "SELECT person_id, platform, account_id, delegate FROM links ORDER BY platform, account_id",
    )
    .all();

describe("the links by platform migration", () => {
  it("keys every link and dismissal by platform, merging what is now one account", () => {
    const sqlite = before(`
      INSERT INTO channels (id, connection_kind, platform, connection_id, created_at) VALUES
        ('telegram', 'telegram', 'telegram', 'c-bot', 1),
        ('telegram_user', 'telegram_user', 'telegram', 'c-user', 1),
        ('slack-2', 'slack_bot', 'slack', 'c-slack', 1);
      INSERT INTO channel_mappings (id, person_id, channel, channel_user_id, delegate) VALUES
        ('m1', 'alice', 'telegram', '111', 0),
        ('m2', 'bob', 'telegram_user', '111', 0),
        ('m3', 'bob', 'telegram_user', '222', 0),
        ('m4', 'ouou', 'agents', 'agent-1', 1),
        ('m5', 'alice', 'slack-2', 'U1', 0),
        ('m6', 'alice', 'wechat_user', 'wx-1', 0);
      INSERT INTO dismissed_accounts (channel, channel_user_id, display_name) VALUES
        ('telegram_user', '111', 'Spam'),
        ('telegram_user', '333', NULL),
        ('telegram', '333', NULL);
    `);

    run(sqlite, LINKS_BY_PLATFORM);

    // The bot met 111 first, so Alice keeps it; the user account's rival link
    // to Bob goes, and the delegate mark rides along.
    expect(links(sqlite)).toEqual([
      { person_id: "ouou", platform: "agents", account_id: "agent-1", delegate: 1 },
      { person_id: "alice", platform: "slack", account_id: "U1", delegate: 0 },
      { person_id: "alice", platform: "telegram", account_id: "111", delegate: 0 },
      { person_id: "bob", platform: "telegram", account_id: "222", delegate: 0 },
      { person_id: "alice", platform: "wechat", account_id: "wx-1", delegate: 0 },
    ]);
    // A dismissal of an account now linked yields to the link, and two
    // dismissals of one account are one.
    expect(sqlite.prepare("SELECT platform, account_id FROM dismissed_accounts").all()).toEqual([
      { platform: "telegram", account_id: "333" },
    ]);
    expect(sqlite.prepare("SELECT * FROM __links_migration_report").all()).toEqual([
      {
        what: "dropped",
        platform: "telegram",
        account_id: "111",
        key: "telegram_user",
        person_id: "bob",
        kept_person_id: "alice",
      },
    ]);
    for (const gone of ["channel_mappings", "__platform_of_key"]) {
      expect(
        sqlite.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(gone),
      ).toBeUndefined();
    }
  });

  it("places each Feishu row by where its sender arrived, then by what Rome holds", () => {
    const sqlite = before(`
      INSERT INTO channels (id, connection_kind, platform, connection_id, created_at) VALUES
        ('${LARK_CHANNEL}', 'feishu', 'lark', 'c-lark', 1);
      INSERT INTO sentinel_log (id, message_id, channel, channel_user_id, action, created_at)
        VALUES ('s1', 'msg-1', '${LARK_CHANNEL}', 'ou_heard', 'escalated', 1);
      INSERT INTO account_profiles (platform, account_id, display_name, source, updated_at)
        VALUES ('feishu', 'ou_profiled', 'Feishu Fan', 'message', 1);
      INSERT INTO channel_mappings (id, person_id, channel, channel_user_id) VALUES
        ('m1', 'alice', 'feishu', 'ou_heard'),
        ('m2', 'bob', 'feishu', 'ou_profiled'),
        ('m3', 'bob', 'feishu', 'ou_unknown');
    `);

    run(sqlite, LINKS_BY_PLATFORM);

    expect(links(sqlite)).toEqual([
      { person_id: "bob", platform: "feishu", account_id: "ou_profiled", delegate: 0 },
      { person_id: "alice", platform: "lark", account_id: "ou_heard", delegate: 0 },
      // Rome holds only a Lark app, so a sender nothing recorded came through it.
      { person_id: "bob", platform: "lark", account_id: "ou_unknown", delegate: 0 },
    ]);
    expect(sqlite.prepare("SELECT * FROM __links_migration_report").all()).toEqual([]);
  });

  it("files an unrecorded Feishu row under feishu, and reports it, while Rome holds both", () => {
    const sqlite = before(`
      INSERT INTO channels (id, connection_kind, platform, connection_id, created_at) VALUES
        ('feishu', 'feishu', 'feishu', 'c-feishu', 1),
        ('${LARK_CHANNEL}', 'feishu', 'lark', 'c-lark', 2);
      INSERT INTO channel_mappings (id, person_id, channel, channel_user_id) VALUES
        ('m1', 'alice', 'feishu', 'ou_unknown');
    `);

    run(sqlite, LINKS_BY_PLATFORM);

    expect(links(sqlite)).toEqual([
      { person_id: "alice", platform: "feishu", account_id: "ou_unknown", delegate: 0 },
    ]);
    expect(sqlite.prepare("SELECT what, account_id FROM __links_migration_report").all()).toEqual([
      { what: "guessed", account_id: "ou_unknown" },
    ]);
  });
});
